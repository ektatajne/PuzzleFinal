import { lobbyService } from "@/lib/game/service";
import { LOBBY_CODE_RE } from "@/lib/game/types";
import { errorResponse } from "@/lib/game/http";

export const dynamic = "force-dynamic";

/** GET /api/lobbies/:code – public, sanitized lobby info for the join page. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await ctx.params;
    if (!LOBBY_CODE_RE.test(code)) {
      return Response.json(
        { error: "BAD_REQUEST", message: "Invalid game code." },
        { status: 400 },
      );
    }
    const lobby = await lobbyService.getLobby(code);
    return Response.json(lobbyService.publicView(lobby));
  } catch (e) {
    return errorResponse(e);
  }
}

/** PATCH /api/lobbies/:code – update arena settings (maxPlayers, gridSize, memorySeconds, puzzleSeconds). */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ code: string }> },
) {
  try {
    const { code } = await ctx.params;
    if (!LOBBY_CODE_RE.test(code)) {
      return Response.json(
        { error: "BAD_REQUEST", message: "Invalid game code." },
        { status: 400 },
      );
    }
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json(
        { error: "BAD_REQUEST", message: "Malformed request body." },
        { status: 400 },
      );
    }
    const { updateLobbySchema } = await import("@/lib/game/types");
    const parsed = updateLobbySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(parsed.error);
    }
    const lobby = await lobbyService.updateConfig(code, parsed.data.token, parsed.data);
    return Response.json({
      ok: true,
      code: lobby.code,
      maxPlayers: lobby.maxPlayers,
      gridSize: lobby.gridCols,
      memorySeconds: lobby.memoryDurationSeconds,
      puzzleSeconds: lobby.puzzleDurationSeconds,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
