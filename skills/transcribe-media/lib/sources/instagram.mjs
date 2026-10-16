import { inspectMetadata, metadataSource } from './yt-dlp.mjs';
export async function inspectInstagram(input, options) { return metadataSource('instagram', input, await inspectMetadata(input, options)); }
