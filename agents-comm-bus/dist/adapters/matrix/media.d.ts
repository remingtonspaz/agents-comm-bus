export interface MxcLocation {
    serverName: string;
    mediaId: string;
}
export declare function parseMxcUri(mxcUri: string): MxcLocation | null;
export interface MatrixMediaDownloadResult {
    content: Uint8Array;
    mime?: string;
}
export interface MatrixMediaUploadRequest {
    content: Uint8Array;
    mime: string;
    filename?: string;
}
export interface MatrixMediaClient {
    download(mxcUri: string): Promise<MatrixMediaDownloadResult>;
    upload(request: MatrixMediaUploadRequest): Promise<string>;
}
export interface FetchMatrixMediaClientOptions {
    fetchFn?: typeof fetch;
}
export declare function createFetchMatrixMediaClient(homeserverUrl: string, accessToken: string, options?: FetchMatrixMediaClientOptions): MatrixMediaClient;
export declare function matrixOutboundMsgtypeForMime(mime: string): "m.image" | "m.file";
export declare const MATRIX_MEDIA_MSGTYPES: Set<string>;
//# sourceMappingURL=media.d.ts.map