import { NextResponse } from "next/server";
import { getSession, validateThreadId } from "@/lib/session-store";

export async function GET(
  _request: Request,
  context: {
    params: Promise<{ threadId: string }>;
  }
) {
  const { threadId } = await context.params;

  try {
    validateThreadId(threadId);
  } catch {
    return NextResponse.json(
      { error: "Invalid thread ID format" },
      { status: 400 }
    );
  }

  try {
    const session = await getSession(threadId);
    return NextResponse.json(session);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 404 }
      );
    }
    return NextResponse.json(
      { error: "Failed to read session" },
      { status: 404 }
    );
  }
}
