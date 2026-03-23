import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("workspace coordinator", { seconds: 30 }, internal.coordinator.runScheduledPass);

export default crons;
