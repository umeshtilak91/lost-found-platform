import "server-only";
import { readWebEnv } from "./env";

// Request-time configuration for server components and route handlers.
// Importing this from a client component fails the build ("server-only").
export const webEnv = readWebEnv();
