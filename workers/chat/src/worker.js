import { handleRequest } from "./router.js";

export { ChatSessionDO } from "./do.js";
export { ChatRunWorkflow } from "./workflow.js";

export default {
  async fetch(req, env) {
    return await handleRequest(req, env);
  },
};
