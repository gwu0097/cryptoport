import "server-only";
import { cache } from "react";

/** The server's clock for this request, in seconds — one value per request
 * (React cache), passed to client components (AgeText, SignalTime) as the
 * anchor for relative times. */
export const requestNowSec = cache((): number => Math.floor(Date.now() / 1000));
