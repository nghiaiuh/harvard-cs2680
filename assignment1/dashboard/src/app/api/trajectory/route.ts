
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Reads the recorded JSONL trajectory and returns it as JSON.
export async function GET() {
  try {
    const filePath = path.resolve(
      process.cwd(),
      "../recordings/events.jsonl"
    );

    const content = await readFile(filePath, "utf8");

    const events = content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    return NextResponse.json({ events });
  } catch (error) {
    console.error("Failed to load trajectory:", error);

    return NextResponse.json(
      { error: "Failed to load trajectory" },
      { status: 500 }
    );
  }
}
