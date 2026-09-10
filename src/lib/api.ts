import { NextResponse } from "next/server";
import { describeError } from "./errors";

/**
 * Wrap a route handler so nothing escapes as an HTML error page.
 *
 * A misconfigured setting throws when the database client is first built,
 * which is before any handler's own try/catch. Unwrapped, that reaches the
 * browser as Next's 500 page — so a caller doing `await response.json()` fails
 * on the response too, and the real message never surfaces anywhere. Every
 * failure leaves an API route as JSON.
 */
export function apiHandler<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      console.error("[api] unhandled error:", error);
      return NextResponse.json({ error: describeError(error) }, { status: 500 });
    }
  };
}
