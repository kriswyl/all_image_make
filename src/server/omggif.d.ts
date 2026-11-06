/** omggif 没有自带类型；这里只声明服务端用来解码动图帧的部分。 */
declare module "omggif" {
  export interface GifFrameInfo {
    x: number;
    y: number;
    width: number;
    height: number;
    has_local_palette: boolean;
    palette_offset: number;
    data_offset: number;
    data_length: number;
    interlaced: boolean;
    /** 1/100 秒 */
    delay: number;
    disposal: number;
    transparent_index: number | null;
  }

  export class GifReader {
    constructor(buffer: Uint8Array);
    readonly width: number;
    readonly height: number;
    numFrames(): number;
    loopCount(): number;
    frameInfo(frameIndex: number): GifFrameInfo;
    decodeAndBlitFrameRGBA(frameIndex: number, pixels: Uint8Array): void;
  }

  export interface GifWriterFrameOptions {
    palette?: number[];
    delay?: number;
    disposal?: number;
    transparent?: number | null;
  }

  export class GifWriter {
    constructor(buffer: Uint8Array, width: number, height: number, options?: { loop?: number; palette?: number[] | null; background?: number });
    addFrame(x: number, y: number, width: number, height: number, indexedPixels: Uint8Array, options?: GifWriterFrameOptions): void;
    end(): number;
  }
}
