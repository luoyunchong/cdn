/**
 * Iconify CDN Worker
 *
 * Reverse proxy for https://api.iconify.design with edge caching.
 */

interface Env {
  BASE_PATH?: string;
}

const UPSTREAM = "https://api.iconify.design";

const CACHE_TTL = 24 * 60 * 60; // 24 hours in seconds

const ALLOWED_ICON_SETS = new Set([
  "line-md",
  "mdi",
  "heroicons",
  "lucide",
  "tabler",
  "ph",
  "ri",
  "fluent",
  "carbon",
  "bi",
  "openmoji",
  "twemoji",
  "noto",
  "flat-color-icons",
  "logos",
  "skill-icons",
]);

// ---------- helpers ----------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
    },
  });
}

function svg(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
    },
  });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function normalizeIconSet(name: string): string {
  // Iconify uses slash format internally, e.g. "mdi" → "mdi", "line-md" → "line-md"
  return name.toLowerCase();
}

function isValidIconSet(name: string): boolean {
  return ALLOWED_ICON_SETS.has(normalizeIconSet(name));
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

// ---------- status page ----------

function statusPage(basePath: string = "/"): Response {
  const b = basePath === "/" ? "" : basePath;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Iconify CDN</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; line-height: 1.6; }
    h1 { margin-bottom: .5rem; }
    h2 { margin-top: 1.5rem; margin-bottom: .5rem; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: .9em; }
    pre { background: #f5f5f5; padding: 1rem; border-radius: 8px; overflow-x: auto; margin: .5rem 0; }
    .sets { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .5rem; }
    .set { background: #e8f4fd; padding: 2px 8px; border-radius: 4px; font-size: .85em; }
  </style>
</head>
<body>
  <h1>🎨 Iconify CDN</h1>
  <p>自建 Iconify 图标 CDN 反向代理，基于 Cloudflare Workers。</p>
  ${basePath !== "/" ? `<p><strong>Base Path:</strong> <code>${basePath}/</code></p>` : ""}

  <h2>接口说明</h2>

  <h3>1. 批量获取图标（JSON 格式）</h3>
  <pre>GET ${b}/:iconSet.json?icons=icon1,icon2,icon3</pre>
  <p>返回标准 Iconify JSON 响应，包含指定图标集中的多个图标。</p>

  <h3>2. 获取单个 SVG</h3>
  <pre>GET ${b}/svg/:iconSet/:iconName.svg</pre>
  <p>返回单个图标的 SVG 内容。</p>

  <h2>支持的图标集</h2>
  <div class="sets">${[...ALLOWED_ICON_SETS].sort().map((s) => `<span class="set">${s}</span>`).join("")}</div>

  <h2>示例</h2>
  <pre>${b}/mdi.json?icons=home,account,settings
${b}/svg/mdi/home.svg
${b}/lucide.json?icons=heart,star,coffee
${b}/svg/lucide/heart.svg</pre>

  <h2>特点</h2>
  <ul style="margin-top:.5rem; padding-left:1.5rem;">
    <li>边缘缓存，TTL 24 小时</li>
    <li>白名单机制，仅允许指定图标集</li>
    <li>CORS 完全开放</li>
    <li>支持二级目录部署（BASE_PATH 环境变量）</li>
    <li>无外部依赖</li>
  </ul>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
    },
  });
}

// ---------- cache ----------

function buildCacheKey(url: URL, path: string): string {
  // Sort icons parameter for deterministic cache keys
  const icons = url.searchParams.get("icons");
  if (icons) {
    const sorted = icons
      .split(",")
      .map((i) => i.trim())
      .filter(Boolean)
      .sort()
      .join(",");
    url.searchParams.set("icons", sorted);
  }
  return new Request(url.toString(), { method: "GET" }).url;
}

async function cachedFetch(
  cacheKey: string,
  upstreamUrl: string,
  ctx: ExecutionContext
): Promise<Response> {
  const cache = caches.default;

  // Try cache first
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  // Fetch from upstream
  const resp = await fetch(upstreamUrl);

  if (!resp.ok) {
    // Don't cache errors
    return resp;
  }

  // Clone and cache asynchronously (non-blocking)
  const toCache = resp.clone();
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(toCache.body, {
        status: toCache.status,
        headers: {
          ...Object.fromEntries(toCache.headers),
          "Cache-Control": `public, max-age=${CACHE_TTL}`,
        },
      })
    )
  );

  return resp;
}

// ---------- router ----------

function getBasePath(env: Env): string {
  const raw = env.BASE_PATH ?? "/";
  // Normalize: ensure starts with / and ends without / (except root "/")
  let bp = raw.startsWith("/") ? raw : "/" + raw;
  if (bp.length > 1 && bp.endsWith("/")) bp = bp.slice(0, -1);
  return bp;
}

async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  const basePath = getBasePath(env);
  const fullPath = url.pathname;

  // Strip base path prefix
  let path: string;
  if (basePath === "/") {
    path = fullPath;
  } else if (fullPath === basePath || fullPath.startsWith(basePath + "/")) {
    path = fullPath.slice(basePath.length) || "/";
  } else {
    // Request doesn't match base path — still route normally (for flexibility)
    path = fullPath;
  }

  // Root → status page
  if (path === "/" || path === "") {
    return statusPage(basePath);
  }

  // GET /:iconSet.json?icons=...
  const jsonMatch = path.match(/^\/([a-z0-9-]+)\.json$/i);
  if (jsonMatch && request.method === "GET") {
    const iconSet = normalizeIconSet(jsonMatch[1]);
    if (!isValidIconSet(iconSet)) {
      return error(
        `不允许的图标集: "${iconSet}"。支持的图标集: ${[...ALLOWED_ICON_SETS].join(", ")}`,
        403
      );
    }

    const icons = url.searchParams.get("icons");
    if (!icons || icons.trim() === "") {
      return error("缺少 icons 参数。示例: ?icons=home,account,settings", 400);
    }

    const upstreamUrl = `${UPSTREAM}/${iconSet}.json?icons=${encodeURIComponent(icons)}`;
    const cacheKey = buildCacheKey(
      new URL(`/${iconSet}.json?icons=${icons}`, url.origin),
      path
    );

    try {
      const resp = await cachedFetch(cacheKey, upstreamUrl, ctx);
      if (!resp.ok) {
        const text = await resp.text();
        return error(`上游返回 ${resp.status}: ${text}`, resp.status);
      }
      const data = await resp.json();
      return json(data);
    } catch (e) {
      return error(`请求上游失败: ${e instanceof Error ? e.message : String(e)}`, 502);
    }
  }

  // GET /svg/:iconSet/:iconName.svg
  const svgMatch = path.match(
    /^\/svg\/([a-z0-9-]+)\/([a-z0-9-]+(?:-[a-z0-9-]+)*)\.svg$/i
  );
  if (svgMatch && request.method === "GET") {
    const iconSet = normalizeIconSet(svgMatch[1]);
    const iconName = svgMatch[2];

    if (!isValidIconSet(iconSet)) {
      return error(
        `不允许的图标集: "${iconSet}"。支持的图标集: ${[...ALLOWED_ICON_SETS].join(", ")}`,
        403
      );
    }

    const upstreamUrl = `${UPSTREAM}/${iconSet}/${iconName}.svg`;
    const cacheKey = `svg/${iconSet}/${iconName}`;

    try {
      const resp = await cachedFetch(cacheKey, upstreamUrl, ctx);
      if (!resp.ok) {
        const text = await resp.text();
        return error(`上游返回 ${resp.status}: ${text}`, resp.status);
      }
      const body = await resp.text();
      return svg(body);
    } catch (e) {
      return error(`请求上游失败: ${e instanceof Error ? e.message : String(e)}`, 502);
    }
  }

  return error("未找到请求的资源。请访问根路径查看接口说明。", 404);
}

// ---------- entry ----------

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (e) {
      return error(
        `内部错误: ${e instanceof Error ? e.message : String(e)}`,
        500
      );
    }
  },
} satisfies ExportedHandler<Env>;
