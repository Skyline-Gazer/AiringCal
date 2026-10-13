/** Minimal R2 + Images surfaces for cover bytes (read path + thumb materialize). */

export type ImageR2Object = {
  arrayBuffer(): Promise<ArrayBuffer>
  httpMetadata?: { contentType?: string }
  customMetadata?: Record<string, string>
}

export type ImageR2Binding = {
  get(key: string): Promise<ImageR2Object | null>
  head(key: string): Promise<unknown | null>
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>
}

export type ThumbImageTransformer = {
  transform(options: { width: number; height: number; fit: string }): ThumbImageTransformer
  output(options: { format: string; quality: number }): Promise<{ image(): ReadableStream<Uint8Array> }>
}

export type ThumbImagesBinding = {
  input(stream: ReadableStream<Uint8Array>): ThumbImageTransformer
}
