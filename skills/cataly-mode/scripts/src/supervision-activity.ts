import { resolve } from "node:path";

export const writerDir = (stateDir: string): string => resolve(stateDir, "lanes", ".supervision-writers");
