import { publicImageFetch } from "../public-image-fetch";

export default {
  async fetch(request: Request, env: Env) {
    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return new Response("Missing URL", { status: 400 });
    }
    try {
      const response = await publicImageFetch(env.LOADER)(target, {
        deadline: Date.now() + 2000,
        headers: {
          Authorization: "fixture-bearer",
          Cookie: "fixture-cookie",
          Referer: "https://private.example/",
        },
        method: "GET",
        signal: AbortSignal.timeout(4000),
      });
      return Response.json({
        body: await response.text(),
        status: response.status,
      });
    } catch (cause) {
      return Response.json({ error: String(cause) });
    }
  },
};
