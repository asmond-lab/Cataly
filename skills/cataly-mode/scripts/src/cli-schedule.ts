import { resolve } from "node:path";
import { type Command, die } from "./cli-context.ts";
import { prepareSchedule, schedulePreview } from "./schedule-prepare.ts";
import { ScheduleStore } from "./schedule-store.ts";
import { observeSystemd } from "./schedule-systemd.ts";
import { scheduleAt, scheduleDestination, ScheduleError, type ScheduleDelivery } from "./schedule-types.ts";
import { scheduleView } from "./schedule-view.ts";

const schedule: Command = async ({ key, positionals, rest, need, opt, values, config, deps }) => {
  if (
    (key === "list" && positionals.length !== 1) ||
    (key === "adopt" && positionals.length > 2) ||
    (["pause", "resume", "remove", "show"].includes(key ?? "") && positionals.length !== 2)
  )
    die(`schedule ${key} has unexpected positional arguments`);
  const store = new ScheduleStore(config.stateDir);
  const name = (): string => positionals[1] || die("schedule needs a name");
  if (values["dry-run"] !== undefined && key !== "add") die("--dry-run is only supported by schedule add");
  if (key === "add") {
    const separator = rest.indexOf("--");
    if (separator < 0 || separator === rest.length - 1) die("schedule add needs -- followed by the command argv");
    const argv = rest.slice(separator + 1);
    if (positionals.length - argv.length !== 2) die("schedule add needs exactly one name before --");
    const deliver = opt("deliver") ?? "wake";
    scheduleDestination(deliver);
    const at = opt("at");
    const every = opt("every-seconds");
    if ([at, every, opt("cron")].filter((v) => v !== undefined).length !== 1)
      die("schedule add needs exactly one of --at ISO_INSTANT or --cron EXPR --tz IANA or --every-seconds N");
    if ((at !== undefined || every !== undefined) && opt("tz") !== undefined) die("--tz requires --cron");
    if (every === undefined && (opt("on-success") !== undefined || values["suppress-unchanged"] !== undefined))
      die("--on-success and --suppress-unchanged require --every-seconds");
    if (every !== undefined && (!/^\d+$/.test(every) || Number(every) < 30 || Number(every) > 86400))
      die("--every-seconds must be an integer from 30 to 86400");
    const mode = opt("on-success") ?? "edge";
    if (mode !== "edge" && mode !== "every") die("--on-success must be edge or every");
    const trigger =
      every !== undefined
        ? {
            condition: {
              everySeconds: Number(every),
              onSuccess: mode as "edge" | "every",
              suppressUnchanged: values["suppress-unchanged"] === true,
            },
          }
        : at === undefined
          ? { cron: need("cron"), tz: need("tz") }
          : { at: scheduleAt(at) };
    const timeout = opt("timeout-seconds");
    if (timeout !== undefined && (!/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 86400))
      die("--timeout-seconds must be an integer from 1 to 86400");
    const input = {
      name: name(),
      ...trigger,
      ...(timeout === undefined ? {} : { timeoutSeconds: Number(timeout) }),
      deliver: deliver as ScheduleDelivery,
      cwd: resolve(typeof values["cwd"] === "string" ? values["cwd"] : process.cwd()),
      argv,
    };
    const now = deps.clock.now();
    if (values["dry-run"] === true) {
      const document = store.read();
      if ([...document.jobs, ...document.adopted].some((entry) => entry.name === input.name))
        die("schedule already exists: " + input.name);
      const { id: _id, ...candidate } = prepareSchedule(input, now);
      const times = schedulePreview({ ...candidate, id: "preview" });
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            candidate,
            occurrences: times.map((at) => new Date(at).toISOString()),
            ...(candidate.tz
              ? {
                  occurrencesLocal: times.map((at) => ({
                    timeZone: candidate.tz,
                    local: new Intl.DateTimeFormat("sv-SE", {
                      timeZone: candidate.tz,
                      dateStyle: "short",
                      timeStyle: "long",
                      hourCycle: "h23",
                    }).format(at),
                  })),
                }
              : {}),
            estimate:
              input.condition !== undefined
                ? "idle polls; completion and delivery can delay later polls"
                : "trigger instants; runner availability unverified",
          },
          null,
          2,
        ),
      );
      return;
    }
    const job = await store.add(input, now);
    console.log(JSON.stringify(job, null, 2));
    if (job.condition !== undefined)
      console.error(
        "SCHEDULE_WARNING condition probes start only when cataly scheduler is running; initial success fires and subsequent errors never rearm an edge",
      );
    if (job.at !== undefined) {
      console.error(
        "SCHEDULE_WARNING adding a one-shot does not start a runner; ensure cataly scheduler is running for this state directory",
      );
      if (job.at - deps.clock.now() < 120_000)
        console.error(
          "SCHEDULE_WARNING one-shot is less than two minutes away; occurrences at least one minute late are missed, never replayed",
        );
    }
  } else if (key === "show") {
    const document = store.read();
    const job = document.jobs.find((entry) => entry.name === name());
    const adopted = document.adopted.find((entry) => entry.name === name());
    if (!job && !adopted) die("schedule not found: " + name());
    const selected = {
      read: () => ({ ...document, jobs: job ? [job] : [], adopted: adopted ? [adopted] : [] }),
      stateDir: store.stateDir,
    };
    console.log(JSON.stringify(await scheduleView(selected, deps.run, deps.clock.now()), null, 2));
  } else if (key === "list") {
    const view = await scheduleView(store, deps.run, deps.clock.now());
    console.log(JSON.stringify(view, null, 2));
    if (view.adopted.some((entry) => "error" in entry)) process.exitCode = 1;
  } else if (key === "adopt") {
    const unit = need("systemd");
    const entry = { name: positionals[1] ?? unit, unit, system: values["system"] === true };
    const observed = await observeSystemd(entry, deps.run, deps.clock.now());
    await store.adopt(entry);
    console.log(JSON.stringify(observed, null, 2));
  } else if (key === "pause" || key === "resume") {
    await store.pause(name(), key === "pause", deps.clock.now(), values["ack-interrupted"] === true);
    console.log("SCHEDULE " + name() + " " + (key === "pause" ? "paused" : "resumed"));
  } else if (key === "remove") {
    await store.remove(name());
    console.log("SCHEDULE " + name() + " removed; retained logs and systemd units were not touched");
  } else die("schedule needs add, show, list, pause, resume, remove or adopt");
};

const scheduler: Command = async ({ values, loopMinutes, config }) => {
  const minutes = values["loop"] === undefined ? 1 / 60 : loopMinutes();
  if (minutes >= 1) throw new ScheduleError("scheduler --loop must be less than 1 minute to avoid skipped occurrences");
  const { Scheduler } = await import("./scheduler.ts");
  const instance = new Scheduler(new ScheduleStore(config.stateDir));
  const stop = new AbortController();
  const interrupt = (): void => {
    stop.abort();
    instance.stop();
  };
  await instance.open();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    for (;;) {
      await instance.tick();
      if (minutes === 0) {
        await instance.settle();
        break;
      }
      if (stop.signal.aborted) break;
      const now = instance.now();
      const delay = instance.store
        .read()
        .jobs.reduce(
          (ms, job) =>
            job.paused || (job.condition && (job.last?.status === "running" || job.last?.delivery === "pending"))
              ? ms
              : Math.min(ms, Math.max(0, job.nextAt - now)),
          minutes * 60_000,
        );
      await new Promise<void>((resolveSleep) => {
        const finish = (): void => {
          clearTimeout(timer);
          stop.signal.removeEventListener("abort", finish);
          resolveSleep();
        };
        const timer = setTimeout(finish, delay);
        stop.signal.addEventListener("abort", finish, { once: true });
        if (stop.signal.aborted) finish();
      });
      if (stop.signal.aborted) break;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await instance.close();
  }
};
export const scheduleCommands: Readonly<Record<string, Command>> = { schedule, scheduler };
