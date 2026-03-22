import express from "express";
import cors from "cors";
import repoRoutes from "./routes/repos.js";
import prRoutes from "./routes/prs.js";
import reviewRoutes from "./routes/reviews.js";
import { getDB, migrateFromJson, resetStaleFixing } from "./services/db.js";
import { startBackgroundPoller } from "./services/poller.js";
import { startWorkflowCoordinator } from "./services/workflow.js";

// Initialize DB and migrate legacy data
getDB();
migrateFromJson();
resetStaleFixing();

const app = express();
const PORT = 3847;

app.use(cors());
app.use(express.json());

app.use("/api/repos", repoRoutes);
app.use("/api/prs", prRoutes);
app.use("/api/reviews", reviewRoutes);

app.listen(PORT, () => {
  console.log(`PR Review server running on http://localhost:${PORT}`);
  // Start background poller (every 5 minutes)
  startBackgroundPoller(5 * 60 * 1000);
  startWorkflowCoordinator(3 * 60 * 1000);
});
