
import { NextResponse } from "next/server";
import { listSessions } from "@/lib/session-store";

export async function GET() {
  try {
    const sessions = await listSessions();

    return NextResponse.json({ sessions });
  } catch {
    return NextResponse.json(
      { error: "Failed to load sessions" },
      { status: 500 }
    );
  }
}
