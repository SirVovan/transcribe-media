import { inspectMetadata, metadataSource } from './yt-dlp.mjs';
export async function inspectYouTube(input, options) { return metadataSource('youtube', input, await inspectMetadata(input, options)); }
