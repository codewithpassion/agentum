// `POST /a2a/webhooks/<taskId>/<token>`: a peer's push for a task we sent it.
// A push is only a nudge. The token in the path is the one thing checked, the
// body is never read, and the service asks the peer for the real state with
// our own credential. Hermes signs its pushes with a secret we do not hold and
// cuts the text, so no body could be trusted anyway. Mount with
// `app.route("/a2a", a2aWebhookRoutes())`.
import { bearerGroup } from "./groups.ts";

const UNAUTHORIZED = 401;
const NO_CONTENT = 204;

export const a2aWebhookRoutes = () => {
  const routes = bearerGroup();

  routes.post("/webhooks/:taskId/:token", async (c) => {
    const { taskId, token } = c.req.param();
    const nudged = await c
      .get("composed")
      .services.a2aOutbound.nudge(taskId, token);
    if (!nudged.ok) {
      return c.json({ error: "Not allowed." }, UNAUTHORIZED);
    }
    return c.body(null, NO_CONTENT);
  });

  return routes;
};
