import { WorkflowEntrypoint } from "cloudflare:workers";
import { runChatRun } from "./run-loop.js";

export class ChatRunWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { sessionId, runId, mode } = event.payload || {};
    if (!sessionId || !runId) {
      throw new Error("ChatRunWorkflow payload requires { sessionId, runId }");
    }
    const sd = this.env.CHAT_SESSION_DO.get(this.env.CHAT_SESSION_DO.idFromName(sessionId));
    return await runChatRun(step, sd, { runId, mode });
  }
}
