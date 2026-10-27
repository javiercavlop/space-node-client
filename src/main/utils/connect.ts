import { SpaceClient } from "../config/SpaceClient";
import { SpaceConnectionOptions } from "../types";

export function connect(options?: SpaceConnectionOptions): SpaceClient{
  
  if (!options || !options.url || !options.apiKey) {
    throw new Error("Both 'url' and 'apiKey' are required to connect to Space.");
  }

  if (options.timeout && (typeof options.timeout !== 'number' || options.timeout <= 0)) {
    throw new Error("Invalid 'timeout' value. It must be a positive number.");
  }

  if (!options.url.startsWith("http://") && !options.url.startsWith("https://")) {
    throw new Error("Invalid 'url'. It must start with 'http://' or 'https://'.");
  }

  if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
    throw new Error("Invalid 'apiKey'. It must be a non-empty string.");
  }
  
  return new SpaceClient({
    url: options.url,
    apiKey: options.apiKey,
    organizationId: options.organizationId,
    timeout: options?.timeout || 5000, // Default timeout to 5000ms if not provided
  });
}