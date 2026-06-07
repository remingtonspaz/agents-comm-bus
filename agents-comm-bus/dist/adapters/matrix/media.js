export function parseMxcUri(mxcUri) {
    const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxcUri.trim());
    if (!match)
        return null;
    const serverName = match[1];
    const mediaId = match[2];
    if (!serverName || !mediaId)
        return null;
    return { serverName, mediaId };
}
export function createFetchMatrixMediaClient(homeserverUrl, accessToken, options = {}) {
    const fetchFn = options.fetchFn ?? fetch;
    const baseUrl = homeserverUrl.replace(/\/+$/, "");
    return {
        async download(mxcUri) {
            const location = parseMxcUri(mxcUri);
            if (!location) {
                throw new Error(`Invalid Matrix MXC URI: ${mxcUri}`);
            }
            const url = `${baseUrl}/_matrix/client/v1/media/download/${encodeURIComponent(location.serverName)}/${encodeURIComponent(location.mediaId)}`;
            const response = await fetchFn(url, {
                method: "GET",
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!response.ok) {
                throw new Error(`Matrix media download failed: HTTP ${response.status}`);
            }
            const mime = response.headers.get("content-type") ?? undefined;
            return {
                content: new Uint8Array(await response.arrayBuffer()),
                mime: mime && mime.length > 0 ? mime : undefined,
            };
        },
        async upload(request) {
            const url = new URL(`${baseUrl}/_matrix/media/v3/upload`);
            if (request.filename) {
                url.searchParams.set("filename", request.filename);
            }
            const response = await fetchFn(url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": request.mime || "application/octet-stream",
                },
                body: Buffer.from(request.content),
            });
            const bodyText = await response.text().catch(() => "");
            if (!response.ok) {
                throw new Error(`Matrix media upload failed: HTTP ${response.status}${bodyText ? ` ${bodyText}` : ""}`);
            }
            const body = bodyText ? JSON.parse(bodyText) : {};
            if (!body.content_uri) {
                throw new Error("Matrix media upload succeeded but response omitted content_uri");
            }
            return body.content_uri;
        },
    };
}
export function matrixOutboundMsgtypeForMime(mime) {
    if (mime.toLowerCase().startsWith("image/"))
        return "m.image";
    return "m.file";
}
export const MATRIX_MEDIA_MSGTYPES = new Set([
    "m.image",
    "m.file",
    "m.audio",
    "m.video",
]);
//# sourceMappingURL=media.js.map