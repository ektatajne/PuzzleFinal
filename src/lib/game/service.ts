/**
 * LobbyService + GameService
 * --------------------------
 * The server is the single source of truth for:
 *   game state, the clock/timer, player status, every player's board,
 *   puzzle validation and winner determination.
 *
 * All mutations run inside `withLobbyLock`, so concurrent completion requests
 * are serialized – only the first can become the winner.
 */
import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin, isSupabaseConfigured } from "@/lib/supabase/admin";
import { config } from "./config";
import { makePlayerId, makeToken, makeGameCode } from "./codes";
import { imageService, SOURCE_VIEWBOX } from "./imageService";
import { manager } from "./manager";
import { findPlayer, lobbyRepo, withLobbyLock, withDbRetry } from "./repo";
import {
  correctSlots,
  generateShuffledBoard,
  isValidBoard,
  isSolved,
  swapPieces,
  validateIndex,
} from "./puzzle";
import {
  EventType,
  GameState,
  VALID_TRANSITIONS,
  PlayerConnection,
  isSupportedGridSize,
  type GameEvent,
  type ImageMeta,
  type Lobby,
  type Player,
} from "./types";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

import { GameError } from "./errors";
export { GameError };

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function ev(
  type: EventType,
  payload: unknown,
  lobbyId?: string,
  gameId?: string | null,
): GameEvent {
  return { type, at: Date.now(), lobbyId, gameId, payload };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return a === b;
  }
}

const globalForActions = globalThis as typeof globalThis & {
  __fuzalClientActions?: Set<string>;
};
const seenClientActions =
  globalForActions.__fuzalClientActions ?? new Set<string>();
if (process.env.NODE_ENV !== "production") {
  globalForActions.__fuzalClientActions = seenClientActions;
}

function isDuplicateActionError(err: any): boolean {
  const msg = String(err?.message || err?.details || "").toLowerCase();
  return String(err?.code || "") === "23505" || msg.includes("duplicate key");
}

function isMissingClientActionsSchema(err: any): boolean {
  const msg = String(err?.message || err?.details || "").toLowerCase();
  return msg.includes("client_actions") || msg.includes("schema cache");
}

function isMissingDimensionSchema(err: any): boolean {
  const msg = String(err?.message || err?.details || "").toLowerCase();
  return (
    msg.includes("grid_cols") ||
    msg.includes("grid_rows") ||
    msg.includes("piece_count") ||
    msg.includes("schema cache")
  );
}

async function claimClientAction(
  code: string,
  lobby: Lobby,
  playerId: string,
  actionType: "SWAP" | "COMPLETE" | "BEGIN_PUZZLE",
  clientGameId?: string | null,
  actionId?: string,
  version?: number,
): Promise<boolean> {
  if (clientGameId && clientGameId !== lobby.currentGameId) {
    console.warn("[ACTION_REJECTED]", {
      actionId: actionId ?? null,
      gameId: lobby.currentGameId ?? null,
      clientGameId,
      playerId,
      actionType,
      reason: "OLD_GAME",
    });
    throw new GameError(
      "OLD_GAME",
      "This action belongs to an older game round.",
      409,
    );
  }
  if (!actionId) return true;

  const normalizedCode = code.toUpperCase();
  const key = `${normalizedCode}:${lobby.currentGameId ?? "no-game"}:${playerId}:${actionId}`;
  if (seenClientActions.has(key)) {
    console.log("[ACTION_DEDUPED]", {
      code: normalizedCode,
      gameId: lobby.currentGameId ?? null,
      playerId,
      actionType,
      actionId,
    });
    return false;
  }
  seenClientActions.add(key);

  if (!isSupabaseConfigured()) return true;

  const { error } = await withDbRetry<any>(
    `claim_client_action(${normalizedCode}:${actionId})`,
    () =>
      supabaseAdmin.from("client_actions").insert({
        lobby_code: normalizedCode,
        game_id: lobby.currentGameId ?? null,
        player_id: playerId,
        action_id: actionId,
        action_type: actionType,
        version: version ?? lobby.version ?? 1,
      }),
    1,
  );

  if (!error) return true;
  if (isDuplicateActionError(error)) {
    console.log("[ACTION_DEDUPED_DB]", {
      code: normalizedCode,
      gameId: lobby.currentGameId ?? null,
      playerId,
      actionType,
      actionId,
    });
    return false;
  }
  if (isMissingClientActionsSchema(error)) {
    console.warn(
      "[ACTION_SCHEMA_WARN] client_actions table is missing; run migration 004_puzzle_dimensions_and_actions.sql.",
    );
    return true;
  }

  console.warn("[ACTION_PERSIST_WARN]", {
    actionType,
    actionId,
    message: error.message,
  });
  return true;
}

function assertTransition(lobby: Lobby, to: GameState) {
  if (!VALID_TRANSITIONS[lobby.status].includes(to)) {
    throw new GameError(
      "INVALID_STATE",
      `Cannot move from ${lobby.status} to ${to}`,
      409,
    );
  }
}

function clearLobbyTimers(lobby: Lobby) {
  if (lobby.timerInterval) clearInterval(lobby.timerInterval);
  if (lobby.endTimeout) clearTimeout(lobby.endTimeout);
  lobby.timerInterval = null;
  lobby.endTimeout = null;
  for (const t of Object.values(lobby.disconnectTimers ?? {})) clearTimeout(t);
  lobby.disconnectTimers = {};
}

function freeSlot(lobby: Lobby): number {
  const used = new Set(lobby.players.map((p) => p.slot));
  for (let i = 0; i < lobby.maxPlayers; i++) if (!used.has(i)) return i;
  return lobby.players.length;
}

/** Player data that is always safe to share with every client. */
export function publicPlayer(p: Player) {
  return {
    id: p.id,
    name: p.name,
    connected: p.connectionStatus === PlayerConnection.CONNECTED,
    score: p.score,
    slot: p.slot,
    eliminated: p.eliminated ?? false,
  };
}

function playerProgress(p: Player) {
  return {
    ...publicPlayer(p),
    moves: p.puzzle?.moves ?? 0,
    correctCount: p.puzzle ? correctSlots(p.puzzle.board).filter(Boolean).length : 0,
    completed: p.puzzle?.completed ?? false,
    eliminated: p.eliminated ?? p.puzzle?.eliminated ?? false,
  };
}

function memoryBlock(lobby: Lobby, now: number) {
  if (!lobby.memory) return null;
  return {
    startedAt: lobby.memory.startedAt,
    endsAt: lobby.memory.endsAt,
    durationSeconds: lobby.memory.durationSeconds,
    remaining: Math.max(
      0,
      Math.ceil((lobby.memory.endsAt - now) / 1000),
    ),
  };
}

async function createGameRoundRecord(
  code: string,
  lobby: Lobby,
  image: ImageMeta,
  startedAt: number,
  endsAt: number,
  logPrefix: string,
): Promise<string | null> {
  try {
    const { data: lobbyRow } = await supabaseAdmin
      .from("lobbies")
      .select("id")
      .eq("code", code.toUpperCase())
      .maybeSingle();

    const { data: imgRow } = await supabaseAdmin
      .from("puzzle_images")
      .select("id")
      .eq("name", image.name)
      .maybeSingle();

    if (!lobbyRow || !imgRow) return null;

    const payload = {
      lobby_id: lobbyRow.id,
      image_id: imgRow.id,
      state: GameState.MEMORY,
      memory_started_at: new Date(startedAt).toISOString(),
      memory_ends_at: new Date(endsAt).toISOString(),
      grid_cols: lobby.gridCols,
      grid_rows: lobby.gridRows,
      piece_count: lobby.pieceCount ?? lobby.gridCols * lobby.gridRows,
    };
    const legacyPayload = {
      lobby_id: payload.lobby_id,
      image_id: payload.image_id,
      state: payload.state,
      memory_started_at: payload.memory_started_at,
      memory_ends_at: payload.memory_ends_at,
    };

    let { data: gameRow, error: gErr } = await supabaseAdmin
      .from("games")
      .insert(payload)
      .select("id")
      .single();

    if (gErr && isMissingDimensionSchema(gErr)) {
      console.warn(
        `[${logPrefix}_SCHEMA_WARN] games grid columns are missing; run migration 004_puzzle_dimensions_and_actions.sql.`,
      );
      ({ data: gameRow, error: gErr } = await supabaseAdmin
        .from("games")
        .insert(legacyPayload)
        .select("id")
        .single());
    }

    if (gameRow) return gameRow.id;
    if (gErr) console.error(`[${logPrefix}_DB_ERR]`, gErr.message);
  } catch (err) {
    console.error(`[${logPrefix}_ERR]`, err);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Lobby service                                                       */
/* ------------------------------------------------------------------ */

export const lobbyService = {
  async createLobby(opts?: {
    gridSize?: number;
    gridCols?: number;
    gridRows?: number;
    maxPlayers?: number;
    memorySeconds?: number;
    puzzleSeconds?: number;
    imageId?: string;
  }): Promise<Lobby> {
    const code = makeGameCode(4);

    let n = 3;
    if (opts?.gridSize !== undefined) {
      if (!isSupportedGridSize(opts.gridSize)) {
        throw new GameError("BAD_REQUEST", `Unsupported grid size ${opts.gridSize}. Supported: 2x2 through 8x8.`, 400);
      }
      n = opts.gridSize;
    } else if (opts?.gridCols !== undefined || opts?.gridRows !== undefined) {
      const cols = opts.gridCols ?? opts.gridRows;
      const rows = opts.gridRows ?? opts.gridCols;
      if (cols !== rows || !isSupportedGridSize(cols)) {
        throw new GameError(
          "BAD_REQUEST",
          `Unsupported grid dimensions ${cols}x${rows}. Only square grids (2x2 through 8x8) are supported.`,
          400,
        );
      }
      n = cols;
    } else if (isSupportedGridSize(config.gridCols)) {
      n = config.gridCols;
    }

    const gridCols = n;
    const gridRows = n;
    const pieceCount = n * n;

    const maxPlayers =
      opts?.maxPlayers && opts.maxPlayers >= 1 && opts.maxPlayers <= 100
        ? opts.maxPlayers
        : config.maxPlayers;

    const memoryDurationSeconds =
      opts?.memorySeconds && opts.memorySeconds >= 5 && opts.memorySeconds <= 600
        ? opts.memorySeconds
        : config.memorySeconds;

    const puzzleDurationSeconds =
      opts?.puzzleSeconds && opts.puzzleSeconds >= 10 && opts.puzzleSeconds <= 3600
        ? opts.puzzleSeconds
        : config.puzzleSeconds;

    const lobby: Lobby = {
      id: `FZ-${code}`,
      code,
      hostToken: makeToken(),
      status: GameState.LOBBY,
      players: [],
      maxPlayers,
      gridCols,
      gridRows,
      pieceCount,
      memoryDurationSeconds,
      puzzleDurationSeconds,
      memory: null,
      puzzleStartedAt: null,
      winnerId: null,
      finishedAt: null,
      lockChain: Promise.resolve(),
      timerInterval: null,
      endTimeout: null,
      usedImageIds: [],
      disconnectTimers: {},
      createdAt: Date.now(),
    };
    await lobbyRepo.put(lobby);
    return lobby;
  },

  async updateConfig(
    code: string,
    hostToken: string,
    opts: {
      gridSize?: number;
      maxPlayers?: number;
      memorySeconds?: number;
      puzzleSeconds?: number;
    },
  ): Promise<Lobby> {
    const lobby = await this.getLobby(code);
    if (lobby.hostToken !== hostToken) {
      throw new GameError("FORBIDDEN", "Invalid host token.", 403);
    }
    if (opts.maxPlayers !== undefined && opts.maxPlayers >= 1 && opts.maxPlayers <= 100) {
      lobby.maxPlayers = opts.maxPlayers;
    }
    if (opts.gridSize !== undefined && isSupportedGridSize(opts.gridSize)) {
      lobby.gridCols = opts.gridSize;
      lobby.gridRows = opts.gridSize;
      lobby.pieceCount = opts.gridSize * opts.gridSize;
    }
    if (opts.memorySeconds !== undefined && opts.memorySeconds >= 5 && opts.memorySeconds <= 600) {
      lobby.memoryDurationSeconds = opts.memorySeconds;
    }
    if (opts.puzzleSeconds !== undefined && opts.puzzleSeconds >= 10 && opts.puzzleSeconds <= 3600) {
      lobby.puzzleDurationSeconds = opts.puzzleSeconds;
    }
    await lobbyRepo.put(lobby);
    await manager.broadcast(code, ev("LOBBY_UPDATED", this.publicView(lobby)));
    return lobby;
  },

  async getLobby(code: string): Promise<Lobby> {
    return await gameService.ensureAuthoritativePhase(code);
  },

  /** Sanitized view for the pre-join page – never leaks tokens/boards. */
  publicView(lobby: Lobby) {
    return {
      code: lobby.code,
      lobbyId: lobby.id,
      status: lobby.status,
      maxPlayers: lobby.maxPlayers,
      playerCount: lobby.players.length,
      players: lobby.players.map(publicPlayer),
      gridCols: lobby.gridCols,
      gridRows: lobby.gridRows,
      pieceCount: lobby.pieceCount ?? lobby.gridCols * lobby.gridRows,
      started:
        lobby.status === GameState.MEMORY || lobby.status === GameState.PUZZLE,
      full: lobby.players.length >= lobby.maxPlayers,
    };
  },

  async join(code: string, name: string): Promise<{ lobby: Lobby; player: Player }> {
    const lobby = await this.getLobby(code);
    return withLobbyLock(lobby, async () => {
      const playerId = makePlayerId();
      const playerToken = makeToken();
      console.log("[PLAYER_SESSION_CREATED]", { code: code.toUpperCase(), playerId, name: name.trim() });

      // Database-level atomic join: locks lobby row, enforces max 5 players, assigns slot 1..5
      const { data: joinRes, error: rpcErr } = await withDbRetry(
        `join_lobby_atomic(${code})`,
        () =>
          supabaseAdmin.rpc("join_lobby_atomic", {
            p_code: code.toUpperCase(),
            p_player_id: playerId,
            p_name: name.trim(),
            p_token_hash: playerToken,
          }),
      );

      if (rpcErr) {
        console.error("[JOIN_RPC_ERROR]", rpcErr.message);
        throw new GameError("BAD_REQUEST", "Failed to join lobby.", 400);
      }

      if (joinRes?.error) {
        console.log("[PLAYER_IDENTITY_CONFLICT]", {
          code: code.toUpperCase(),
          playerId,
          reason: joinRes.error,
        });
        const httpStatus =
          joinRes.error === "FULL" || joinRes.error === "CONFLICT"
            ? 409
            : joinRes.error === "ALREADY_STARTED"
              ? 403
              : 400;
        throw new GameError(joinRes.error, joinRes.message, httpStatus);
      }

      const assignedSlot = Number(joinRes?.slot ?? freeSlot(lobby));
      console.log("[PLAYER_JOIN_ACCEPTED]", {
        code: code.toUpperCase(),
        playerId,
        name: name.trim(),
        slot: assignedSlot,
      });

      const player: Player = {
        id: playerId,
        name: name.trim(),
        token: playerToken,
        joinedAt: Date.now(),
        connectionStatus: PlayerConnection.CONNECTED,
        score: 0,
        slot: assignedSlot,
        puzzle: null,
      };

      const existingIdx = lobby.players.findIndex((p) => p.id === player.id);
      if (existingIdx >= 0) {
        lobby.players[existingIdx] = player;
      } else {
        lobby.players.push(player);
      }

      await manager.broadcast(
        code,
        ev(EventType.PLAYER_JOINED, { player: publicPlayer(player) }, lobby.id),
      );
      await manager.broadcast(
        code,
        ev(
          EventType.LOBBY_UPDATED,
          { players: lobby.players.map(publicPlayer), status: lobby.status },
          lobby.id,
        ),
      );
      return { lobby, player };
    });
  },

  /** A player (or host) opened/re-opened the event stream. */
  async handleConnect(
    code: string,
    opts: { hostToken?: string; playerId?: string; playerToken?: string },
  ): Promise<{ lobby: Lobby; kind: "host" | "player"; player?: Player }> {
    const fastLobby = lobbyRepo.getByCodeFast?.(code);
    const now = Date.now();
    const needsTransition =
      fastLobby &&
      ((fastLobby.status === GameState.MEMORY && fastLobby.memory?.endsAt && now >= fastLobby.memory.endsAt) ||
        (fastLobby.status === GameState.PUZZLE && fastLobby.puzzleEndsAt && now >= fastLobby.puzzleEndsAt));

    let lobby: Lobby;
    if (
      !needsTransition &&
      fastLobby &&
      ((opts.hostToken && safeEqual(opts.hostToken, fastLobby.hostToken)) ||
        (opts.playerId &&
          opts.playerToken &&
          fastLobby.players.some(
            (p) => p.id === opts.playerId && safeEqual(opts.playerToken!, p.token),
          )))
    ) {
      lobby = fastLobby;
    } else {
      lobby = await this.getLobby(code);
    }

    if (opts.hostToken) {
      if (!safeEqual(opts.hostToken, lobby.hostToken)) {
        throw new GameError("FORBIDDEN", "Invalid host token.", 403);
      }
      return { lobby, kind: "host" };
    }
    const player = findPlayer(lobby, opts.playerId ?? "");
    if (!player || !opts.playerToken || !safeEqual(opts.playerToken, player.token)) {
      console.log("[PLAYER_IDENTITY_CONFLICT]", {
        code: code.toUpperCase(),
        playerId: opts.playerId,
        reason: !player ? "PLAYER_NOT_FOUND" : "TOKEN_MISMATCH",
      });
      throw new GameError("SESSION_EXPIRED", "Player session expired or not found in lobby.", 410);
    }
    // Reconnect: cancel pending removal / flip status back to connected.
    const pending = lobby.disconnectTimers?.[player.id];
    if (pending) {
      clearTimeout(pending);
      delete lobby.disconnectTimers[player.id];
    }
    console.log("[PLAYER_RECONNECT]", {
      code: code.toUpperCase(),
      playerId: player.id,
      name: player.name,
      previousStatus: player.connectionStatus,
    });
    if (player.connectionStatus === PlayerConnection.DISCONNECTED) {
      player.connectionStatus = PlayerConnection.CONNECTED;
      await lobbyRepo.put(lobby);
      await manager.broadcast(
        code,
        ev(
          EventType.PLAYER_STATUS,
          { playerId: player.id, connected: true, player: publicPlayer(player) },
          lobby.id,
        ),
      );
      await manager.broadcast(
        code,
        ev(
          EventType.LOBBY_UPDATED,
          { players: lobby.players.map(publicPlayer), status: lobby.status },
          lobby.id,
        ),
      );
    }
    return { lobby, kind: "player", player };
  },

  async handleDisconnect(code: string, playerId: string): Promise<void> {
    const lobby = await lobbyRepo.getByCode(code);
    if (!lobby) return;
    const player = findPlayer(lobby, playerId);
    if (!player) return;
    // Short grace window absorbs page refreshes / network blips.
    lobby.disconnectTimers[playerId] = setTimeout(() => {
      const current = lobby.players.find((p) => p.id === playerId);
      if (!current) return;
      current.connectionStatus = PlayerConnection.DISCONNECTED;
      void manager.broadcast(
        code,
        ev(
          EventType.PLAYER_STATUS,
          { playerId, connected: false, player: publicPlayer(current) },
          lobby.id,
        ),
      );
      void manager.broadcast(
        code,
        ev(
          EventType.LOBBY_UPDATED,
          { players: lobby.players.map(publicPlayer), status: lobby.status },
          lobby.id,
        ),
      );
      // In the lobby a permanently-gone phone frees its seat; mid-game it keeps it.
      if (lobby.status === GameState.LOBBY) {
        const grace = setTimeout(async () => {
          const fresh = await lobbyRepo.getByCode(code);
          if (!fresh) return;
          const stillThere = findPlayer(fresh, playerId);
          if (
            stillThere &&
            stillThere.connectionStatus === PlayerConnection.DISCONNECTED &&
            fresh.status === GameState.LOBBY
          ) {
            fresh.players = fresh.players.filter((p) => p.id !== playerId);
            await lobbyRepo.put(fresh);
            void manager.broadcast(
              code,
              ev(EventType.PLAYER_LEFT, { playerId }, fresh.id),
            );
            void manager.broadcast(
              code,
              ev(
                EventType.LOBBY_UPDATED,
                { players: fresh.players.map(publicPlayer), status: fresh.status },
                fresh.id,
              ),
            );
          }
        }, config.disconnectGraceMs);
        lobby.disconnectTimers[`${playerId}:remove`] = grace;
      }
    }, 2500);
  },

  /* ---------------------------------------------------------------- */
  /* Snapshot sent on (re)connect – role-specific, anti-cheat aware    */
  /* ---------------------------------------------------------------- */

  buildSnapshot(lobby: Lobby, kind: "host" | "player", you?: Player) {
    const now = Date.now();
    const base = {
      type: EventType.SNAPSHOT,
      at: now,
      lobbyId: lobby.id,
      payload: {
        code: lobby.code,
        lobbyId: lobby.id,
        status: lobby.status,
        maxPlayers: lobby.maxPlayers,
        gridCols: lobby.gridCols,
        gridRows: lobby.gridRows,
        pieceCount: lobby.pieceCount ?? lobby.gridCols * lobby.gridRows,
        currentGameId: lobby.currentGameId ?? null,
        serverNow: now,
        players: lobby.players.map(publicPlayer),
        you: you ? { id: you.id, name: you.name, score: you.score } : null,
        isHost: kind === "host",
        memory: null as null | ReturnType<typeof memoryBlock>,
        image: null as null | { id: string; url: string; name: string },
        imageName: null as string | null,
        puzzle: null as null | Record<string, unknown>,
        puzzleStartedAt: lobby.puzzleStartedAt,
        puzzleEndsAt:
          lobby.puzzleEndsAt ??
          (lobby.puzzleStartedAt ? lobby.puzzleStartedAt + (lobby.puzzleDurationSeconds ?? config.puzzleSeconds) * 1000 : null),
        puzzleDurationSeconds: lobby.puzzleDurationSeconds ?? config.puzzleSeconds,
        memoryDurationSeconds: lobby.memoryDurationSeconds ?? config.memorySeconds,
        puzzleProgress: null as null | ReturnType<typeof playerProgress>[],
        result: null as null | Record<string, unknown>,
      },
    };
    const p = base.payload;

    if (lobby.status === GameState.MEMORY && lobby.memory) {
      p.memory = memoryBlock(lobby, now);
      if (kind === "host") {
        p.image = { ...lobby.memory.image };
      } else {
        p.imageName = lobby.memory.image.name;
      }
    }

    if (lobby.status === GameState.PUZZLE) {
      p.puzzleProgress = lobby.players.map(playerProgress);
      if (kind === "player" && you?.puzzle) {
        p.puzzle = {
          playerId: you.id,
          board: you.puzzle.board,
          moves: you.puzzle.moves,
          version: you.puzzle.version ?? lobby.version ?? 1,
          startedAt: you.puzzle.startedAt,
          correctSlots: correctSlots(you.puzzle.board),
          eliminated: you.eliminated ?? you.puzzle.eliminated ?? false,
          completed: you.puzzle.completed,
        };
      }
    }

    if (lobby.status === GameState.FINISHED) {
      p.puzzleProgress = lobby.players.map(playerProgress);
      if (kind === "player" && you?.puzzle) {
        p.puzzle = {
          playerId: you.id,
          board: you.puzzle.board,
          moves: you.puzzle.moves,
          version: you.puzzle.version ?? lobby.version ?? 1,
          startedAt: you.puzzle.startedAt,
          correctSlots: correctSlots(you.puzzle.board),
          eliminated: you.eliminated ?? you.puzzle.eliminated ?? false,
          completed: you.puzzle.completed,
        };
      }
      p.result = resultPayload(lobby);
    }
    return { ...base, gameId: lobby.currentGameId ?? null };
  },
};

/* ------------------------------------------------------------------ */
/* Result / standings                                                 */
/* ------------------------------------------------------------------ */

function resultPayload(lobby: Lobby) {
  const winner = lobby.players.find((p) => p.id === lobby.winnerId) ?? null;
  const startedAt = lobby.puzzleStartedAt ?? Date.now();
  const timeExpired =
    !winner &&
    !!lobby.puzzleEndsAt &&
    (lobby.finishedAt ?? Date.now()) >= lobby.puzzleEndsAt;
  const standings = lobby.players
    .map((p) => ({
      ...publicPlayer(p),
      moves: p.puzzle?.moves ?? 0,
      correctCount: p.puzzle
        ? correctSlots(p.puzzle.board).filter(Boolean).length
        : 0,
      completed: p.puzzle?.completed ?? false,
      eliminated: p.eliminated ?? (!p.puzzle?.completed && (!winner || timeExpired)),
      durationMs: p.puzzle?.completedAt ? p.puzzle.completedAt - startedAt : null,
    }))
    .sort((a, b) => {
      if (a.id === winner?.id) return -1;
      if (b.id === winner?.id) return 1;
      return b.correctCount - a.correctCount || a.moves - b.moves;
    });
  return {
    gameId: lobby.currentGameId ?? null,
    winner: winner ? publicPlayer(winner) : null,
    timeExpired,
    finishedAt: lobby.finishedAt,
    durationMs:
      lobby.finishedAt && lobby.puzzleStartedAt
        ? (timeExpired ? Math.min(lobby.finishedAt - lobby.puzzleStartedAt, (lobby.puzzleDurationSeconds ?? config.puzzleSeconds) * 1000) : lobby.finishedAt - lobby.puzzleStartedAt)
        : (timeExpired ? (lobby.puzzleDurationSeconds ?? config.puzzleSeconds) * 1000 : null),
    image: lobby.memory?.image ? { ...lobby.memory.image } : null,
    standings,
  };
}

/* ------------------------------------------------------------------ */
/* Game service – state machine, timers, validation, winner           */
/* ------------------------------------------------------------------ */

function assertHost(lobby: Lobby, token: string) {
  if (!safeEqual(token, lobby.hostToken)) {
    throw new GameError("FORBIDDEN", "Only the host can do that.", 403);
  }
}

export const gameService = {
  /** Authoritative phase reconciliation & safe lazy transition */
  async ensureAuthoritativePhase(code: string): Promise<Lobby> {
    const normCode = code.toUpperCase();
    const lobby = lobbyRepo.getByCodeFast?.(normCode) ?? (await lobbyRepo.getByCode(normCode));
    if (!lobby) throw new GameError("NOT_FOUND", "Lobby not found.", 404);

    const now = Date.now();
    console.log("[PHASE_READ]", {
      gameId: lobby.currentGameId ?? null,
      status: lobby.status,
      serverNow: now,
      memoryEndsAt: lobby.memory?.endsAt ?? null,
      puzzleEndsAt: lobby.puzzleEndsAt ?? null,
    });

    if (
      lobby.status === GameState.MEMORY &&
      lobby.memory?.endsAt &&
      now >= lobby.memory.endsAt
    ) {
      console.log("[PHASE_TRANSITION]", {
        gameId: lobby.currentGameId ?? null,
        oldStatus: GameState.MEMORY,
        newStatus: GameState.PUZZLE,
        reason: "EXPIRED_MEMORY_LAZY_TRANSITION",
        serverNow: now,
        memoryEndsAt: lobby.memory.endsAt,
        puzzleEndsAt: lobby.puzzleEndsAt ?? null,
      });
      await gameService.beginPuzzle(normCode, true);
      return lobbyRepo.getByCodeFast?.(normCode) ?? (await lobbyRepo.getByCode(normCode)) ?? lobby;
    }

    if (
      lobby.status === GameState.PUZZLE &&
      lobby.puzzleEndsAt &&
      now >= lobby.puzzleEndsAt
    ) {
      console.log("[PHASE_TRANSITION]", {
        gameId: lobby.currentGameId ?? null,
        oldStatus: GameState.PUZZLE,
        newStatus: GameState.FINISHED,
        reason: "PUZZLE_TIMEOUT_LAZY_TRANSITION",
        serverNow: now,
        memoryEndsAt: lobby.memory?.endsAt ?? null,
        puzzleEndsAt: lobby.puzzleEndsAt,
      });
      await gameService.handlePuzzleTimeout(normCode);
      return lobbyRepo.getByCodeFast?.(normCode) ?? (await lobbyRepo.getByCode(normCode)) ?? lobby;
    }

    return lobby;
  },

  /** LOBBY → MEMORY */
  async startGame(code: string, hostToken: string): Promise<void> {
    const lobby = await lobbyRepo.getByCode(code);
    if (!lobby) throw new GameError("NOT_FOUND", "Lobby not found.", 404);
    await withLobbyLock(lobby, async () => {
      assertHost(lobby, hostToken);
      if (lobby.status === GameState.MEMORY || lobby.status === GameState.PUZZLE) {
        console.log("[START_GAME_ALREADY_ACTIVE]", {
          code: code.toUpperCase(),
          gameId: lobby.currentGameId ?? null,
          status: lobby.status,
        });
        return;
      }
      assertTransition(lobby, GameState.MEMORY);
      if (lobby.players.length === 0) {
        throw new GameError("BAD_REQUEST", "At least one player must join before starting.", 400);
      }
      const image = imageService.getRandomImage(lobby.usedImageIds);
      lobby.usedImageIds.push(image.id);
      const durationSeconds = lobby.memoryDurationSeconds ?? config.memorySeconds;
      const startedAt = Date.now();
      const endsAt = startedAt + durationSeconds * 1000;
      lobby.version = 1;
      lobby.status = GameState.MEMORY;
      lobby.memory = { image, startedAt, endsAt, durationSeconds };
      lobby.winnerId = null;
      lobby.finishedAt = null;
      for (const p of lobby.players) p.puzzle = null;

      const gameRowId = await createGameRoundRecord(
        code,
        lobby,
        image,
        startedAt,
        endsAt,
        "START_GAME",
      );
      if (gameRowId) lobby.currentGameId = gameRowId;

      await lobbyRepo.put(lobby);

      const gameId = lobby.currentGameId ?? null;
      const pieceCount = lobby.gridCols * lobby.gridRows;

      await manager.broadcast(
        code,
        ev(
          EventType.GAME_STARTED,
          { status: lobby.status, at: startedAt, gameId, pieceCount },
          lobby.id,
          gameId,
        ),
      );
      // Host (big screen) receives the real image; phones only get the name.
      await manager.sendToHost(
        code,
        ev(
          EventType.MEMORY_PHASE_STARTED,
          {
            image,
            startedAt,
            endsAt,
            durationSeconds,
            gameId,
            gridCols: lobby.gridCols,
            gridRows: lobby.gridRows,
            pieceCount,
          },
          lobby.id,
          gameId,
        ),
      );
      await manager.broadcastToPlayers(
        code,
        ev(
          EventType.MEMORY_PHASE_STARTED,
          {
            imageName: image.name,
            startedAt,
            endsAt,
            durationSeconds,
            gameId,
            gridCols: lobby.gridCols,
            gridRows: lobby.gridRows,
            pieceCount,
          },
          lobby.id,
          gameId,
        ),
      );
      await manager.broadcast(
        code,
        ev(
          EventType.MEMORY_TIMER_UPDATED,
          { remaining: durationSeconds, endsAt, gameId },
          lobby.id,
          gameId,
        ),
      );

      // Authoritative server clock: tick every second, hard transition at end.
      lobby.timerInterval = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
        void manager.broadcast(
          code,
          ev(EventType.MEMORY_TIMER_UPDATED, { remaining, endsAt, gameId }, lobby.id, gameId),
        );
      }, 1000);
      (lobby.timerInterval as any)?.unref?.();

      lobby.endTimeout = setTimeout(() => {
        void gameService.beginPuzzle(code).catch((e) => console.error("beginPuzzle", e));
      }, durationSeconds * 1000 + 60);
      (lobby.endTimeout as any)?.unref?.();
    });
  },

  /** MEMORY → PUZZLE (also called by the hard server timeout) */
  async beginPuzzle(code: string, force = (process.env.NODE_ENV === "test")): Promise<void> {
    const lobby = lobbyRepo.getByCodeFast?.(code) ?? (await lobbyRepo.getByCode(code));
    if (!lobby) throw new GameError("NOT_FOUND", "Lobby not found.", 404);
    await withLobbyLock(lobby, async () => {
      if (lobby.status === GameState.PUZZLE) {
        console.log("[BEGIN_PUZZLE_ALREADY_ACTIVE]", {
          gameId: lobby.currentGameId ?? null,
          status: lobby.status,
        });
        return; // idempotent re-entry
      }
      if (lobby.status === GameState.FINISHED) return; // cannot move back to PUZZLE if finished
      if (lobby.status === GameState.LOBBY) {
        console.log("[BEGIN_PUZZLE_IGNORED_LOBBY]", {
          gameId: lobby.currentGameId ?? null,
          status: lobby.status,
        });
        assertTransition(lobby, GameState.PUZZLE);
        return;
      }

      const now = Date.now();
      const clockSkewToleranceMs = 500;
      if (
        !force &&
        lobby.status === GameState.MEMORY &&
        lobby.memory?.endsAt &&
        now + clockSkewToleranceMs < lobby.memory.endsAt
      ) {
        console.warn("[BEGIN_PUZZLE_PREMATURE_REJECTED]", {
          gameId: lobby.currentGameId ?? null,
          now,
          memoryEndsAt: lobby.memory.endsAt,
          remainingMs: lobby.memory.endsAt - now,
        });
        return; // Guard: do not cut memory countdown short
      }

      assertTransition(lobby, GameState.PUZZLE);
      clearLobbyTimers(lobby);

      const durationSeconds = lobby.puzzleDurationSeconds ?? config.puzzleSeconds;
      const startedAt = Date.now();
      const endsAt = startedAt + durationSeconds * 1000;

      // Atomic conditional update on Supabase games table
      if (lobby.currentGameId && isSupabaseConfigured()) {
        const { data: updatedGame, error: updateErr } = await withDbRetry(
          `atomic_begin_puzzle(${lobby.currentGameId})`,
          () =>
            supabaseAdmin
              .from("games")
              .update({
                state: GameState.PUZZLE,
                puzzle_started_at: new Date(startedAt).toISOString(),
              })
              .eq("id", lobby.currentGameId)
              .eq("state", GameState.MEMORY)
              .select("id, state"),
        );
        if (!updateErr && (!updatedGame || updatedGame.length === 0)) {
          const { data: currentGame } = await withDbRetry(
            `check_game_state(${lobby.currentGameId})`,
            () =>
              supabaseAdmin
                .from("games")
                .select("state")
                .eq("id", lobby.currentGameId)
                .maybeSingle(),
          );
          const currentState = (currentGame as { state?: string } | null)?.state;
          if (currentState === GameState.PUZZLE) {
            lobby.status = GameState.PUZZLE;
            return;
          }
          if (currentState === GameState.FINISHED) {
            lobby.status = GameState.FINISHED;
            return;
          }
        }
      }

      const oldStatus = lobby.status;
      lobby.status = GameState.PUZZLE;
      lobby.puzzleStartedAt = startedAt;
      lobby.puzzleEndsAt = endsAt;
      lobby.puzzleDurationSeconds = durationSeconds;
      lobby.version = (lobby.version || 1);
      const total = lobby.gridCols * lobby.gridRows;
      lobby.pieceCount = total;
      const gameId = lobby.currentGameId ?? null;

      console.log("[BEGIN_PUZZLE_ACCEPTED]", {
        gameId,
        serverNow: startedAt,
        memoryEndsAt: lobby.memory?.endsAt ?? null,
        puzzleEndsAt: endsAt,
      });
      console.log("[PHASE_TRANSITION]", {
        gameId,
        oldStatus,
        newStatus: GameState.PUZZLE,
        serverNow: startedAt,
        memoryEndsAt: lobby.memory?.endsAt ?? null,
        puzzleEndsAt: endsAt,
      });
      console.log("[PUZZLE_INIT]", {
        gameId,
        pieceCount: total,
        rows: lobby.gridRows,
        cols: lobby.gridCols,
      });

      for (const p of lobby.players) {
        // Every player receives an independent shuffle if not already initialized.
        if (!p.puzzle || p.puzzle.board.length !== total) {
          p.puzzle = {
            board: generateShuffledBoard(total),
            moves: 0,
            startedAt: lobby.puzzleStartedAt,
            completed: false,
            completedAt: null,
            eliminated: false,
            version: lobby.version,
          };
        } else {
          p.puzzle.version = lobby.version;
        }
        p.eliminated = false;
      }
      await lobbyRepo.put(lobby);

      await manager.broadcast(
        code,
        ev(
          EventType.PUZZLE_STARTED,
          {
            startedAt,
            endsAt,
            durationSeconds,
            gridCols: lobby.gridCols,
            gridRows: lobby.gridRows,
            pieceCount: total,
            gameId,
            players: lobby.players.map(playerProgress),
          },
          lobby.id,
          gameId,
        ),
      );
      // Personal shuffles go directly to each player only.
      for (const p of lobby.players) {
        const pz = p.puzzle;
        if (!pz) continue;
        await manager.sendToPlayer(
          code,
          p.id,
          ev(
            EventType.PUZZLE_STARTED,
            {
              playerId: p.id,
              board: pz.board,
              moves: 0,
              version: pz.version ?? lobby.version ?? 1,
              startedAt,
              endsAt,
              durationSeconds,
              gridCols: lobby.gridCols,
              gridRows: lobby.gridRows,
              pieceCount: total,
              gameId,
            },
            lobby.id,
            gameId,
          ),
        );
      }

      // Authoritative 3-minute countdown clock: tick every second
      lobby.timerInterval = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
        void manager.broadcast(
          code,
          ev(
            EventType.PUZZLE_TIMER_UPDATED,
            { remaining, endsAt, durationSeconds, gameId },
            lobby.id,
            gameId,
          ),
        );
      }, 1000);
      (lobby.timerInterval as any)?.unref?.();

      // Hard server timeout after exactly 3 minutes: eliminates unsolved players
      lobby.endTimeout = setTimeout(() => {
        void gameService.handlePuzzleTimeout(code).catch((e) => console.error("puzzleTimeout", e));
      }, durationSeconds * 1000 + 100);
      (lobby.endTimeout as any)?.unref?.();
    });
  },

  /** Authoritative 3-minute expiration: eliminates unsolved players and ends round */
  async handlePuzzleTimeout(code: string): Promise<void> {
    const lobby = await lobbyRepo.getByCode(code);
    if (!lobby) return;
    await withLobbyLock(lobby, async () => {
      if (lobby.status !== GameState.PUZZLE) return;

      clearLobbyTimers(lobby);
      const gameId = lobby.currentGameId ?? null;

      // Eliminate all players whose puzzle is not completed
      for (const p of lobby.players) {
        if (!p.puzzle?.completed) {
          p.eliminated = true;
          if (p.puzzle) p.puzzle.eliminated = true;
          await manager.sendToPlayer(
            code,
            p.id,
            ev(
              EventType.PLAYER_ELIMINATED,
              {
                playerId: p.id,
                reason: "TIME_EXPIRED",
                message: "Time's up! You were eliminated because the 3-minute limit expired.",
                gameId,
              },
              lobby.id,
              gameId,
            ),
          );
        }
      }

      assertTransition(lobby, GameState.FINISHED);
      lobby.status = GameState.FINISHED;
      lobby.winnerId = null; // No winner if 3 minutes expire without solution
      lobby.finishedAt = lobby.puzzleEndsAt ? Math.min(Date.now(), lobby.puzzleEndsAt) : Date.now();

      await lobbyRepo.put(lobby);

      await manager.broadcast(
        lobby.code,
        ev(EventType.GAME_FINISHED, resultPayload(lobby), lobby.id, gameId),
      );
    });
  },

  /**
   * Apply a tap-to-swap move. Player → server → authoritative validation.
   * Runs under the per-lobby lock so the first solved board is the only winner.
   */
  async applySwap(
    code: string,
    playerId: string,
    token: string,
    from: number,
    to: number,
    clientGameId?: string | null,
    actionId?: string,
  ): Promise<{
    gameId: string | null;
    actionId?: string | null;
    version: number;
    board: number[];
    moves: number;
    correctSlots: boolean[];
    completed: boolean;
    status: GameState;
  }> {
    const lobby = lobbyRepo.getByCodeFast?.(code) ?? (await lobbyRepo.getByCode(code));
    if (!lobby) throw new GameError("NOT_FOUND", "Lobby not found.", 404);
    return await withLobbyLock(lobby, async () => {
      const player = findPlayer(lobby, playerId);
      if (!player) throw new GameError("NOT_FOUND", "Player not found.", 404);
      if (!safeEqual(token, player.token)) {
        throw new GameError("FORBIDDEN", "Invalid player token.", 403);
      }
      const claimed = await claimClientAction(
        code,
        lobby,
        player.id,
        "SWAP",
        clientGameId,
        actionId,
        player.puzzle?.version ?? lobby.version,
      );
      if (!claimed) {
        return {
          gameId: lobby.currentGameId ?? null,
          actionId: actionId ?? null,
          version: player.puzzle?.version ?? lobby.version ?? 1,
          board: player.puzzle?.board ?? [],
          moves: player.puzzle?.moves ?? 0,
          correctSlots: player.puzzle ? correctSlots(player.puzzle.board) : [],
          completed: player.puzzle?.completed ?? false,
          status: lobby.status,
        };
      }
      if (lobby.status !== GameState.PUZZLE) {
        throw new GameError("INVALID_STATE", "The puzzle is not active.", 409);
      }
      if (player.eliminated || player.puzzle?.eliminated) {
        throw new GameError("FORBIDDEN", "You have been eliminated.", 403);
      }
      if (lobby.puzzleEndsAt && Date.now() > lobby.puzzleEndsAt) {
        player.eliminated = true;
        if (player.puzzle) player.puzzle.eliminated = true;
        throw new GameError("TIME_EXPIRED", "3-minute time limit has expired. You are eliminated.", 400);
      }
      const puzzle = player.puzzle;
      if (!puzzle || puzzle.completed) {
        throw new GameError("INVALID_STATE", "No active puzzle for player.", 409);
      }
      const total = lobby.gridCols * lobby.gridRows;
      const gameId = lobby.currentGameId ?? null;
      if (!isValidBoard(puzzle.board, total)) {
        throw new GameError("INVALID_STATE", "Authoritative puzzle board is invalid.", 409);
      }
      if (!validateIndex(from, total) || !validateIndex(to, total)) {
        throw new GameError("BAD_REQUEST", "Invalid puzzle index.", 422);
      }
      if (from === to) {
        return {
          gameId,
          actionId: actionId ?? null,
          version: puzzle.version ?? lobby.version ?? 1,
          board: puzzle.board,
          moves: puzzle.moves,
          correctSlots: correctSlots(puzzle.board),
          completed: puzzle.completed,
          status: lobby.status,
        };
      }

      // Monotonically increase authoritative version
      lobby.version = (lobby.version || 0) + 1;
      puzzle.version = lobby.version;

      console.log("[ACTION_ACCEPTED]", {
        actionId: actionId ?? null,
        gameId,
        playerId,
        actionType: "SWAP",
        version: puzzle.version,
      });

      const before = [...puzzle.board];
      puzzle.board = swapPieces(puzzle.board, from, to);
      puzzle.moves += 1;
      console.log("[BOARD_MUTATION]", {
        cause: "USER_SWAP",
        gameId,
        playerId,
        from,
        to,
        actionId: actionId ?? null,
        before,
        after: puzzle.board,
      });

      const solved = isSolved(puzzle.board, total);
      if (solved) {
        puzzle.completed = true;
        puzzle.completedAt = Date.now();
        await lobbyRepo.put(lobby);

        await manager.sendToPlayer(
          code,
          player.id,
          ev(
            EventType.PUZZLE_MOVE,
            {
              playerId: player.id,
              board: puzzle.board,
              moves: puzzle.moves,
              correctSlots: correctSlots(puzzle.board),
              completed: true,
              pieceCount: total,
              gameId,
              actionId,
              version: puzzle.version,
            },
            lobby.id,
            gameId,
          ),
        );
        await manager.broadcast(
          code,
          ev(
            EventType.PLAYER_COMPLETED,
            { playerId: player.id, at: puzzle.completedAt, gameId },
            lobby.id,
            gameId,
          ),
        );
        await gameService.finish(lobby, player);
        return {
          gameId,
          actionId: actionId ?? null,
          version: puzzle.version,
          board: puzzle.board,
          moves: puzzle.moves,
          correctSlots: correctSlots(puzzle.board),
          completed: true,
          status: lobby.status,
        };
      }

      // Fast-path persistence: updates single player row in game_players rather than 8-table cascade
      if (lobbyRepo.savePlayerSwap) {
        await lobbyRepo.savePlayerSwap(lobby, player.id, actionId);
      } else {
        await lobbyRepo.put(lobby);
      }

      await manager.sendToPlayer(
        code,
        player.id,
        ev(
          EventType.PUZZLE_MOVE,
          {
            playerId: player.id,
            board: puzzle.board,
            moves: puzzle.moves,
            correctSlots: correctSlots(puzzle.board),
            completed: false,
            pieceCount: total,
            gameId,
            actionId,
            version: puzzle.version,
          },
          lobby.id,
          gameId,
        ),
      );
      // Host sees only progress counts – never the arrangement.
      await manager.sendToHost(
        code,
        ev(
          EventType.PUZZLE_MOVE,
          { playerId: player.id, moves: puzzle.moves, correctCount:
            correctSlots(puzzle.board).filter(Boolean).length, gameId, actionId },
          lobby.id,
          gameId,
        ),
      );

      return {
        gameId,
        actionId: actionId ?? null,
        version: puzzle.version,
        board: puzzle.board,
        moves: puzzle.moves,
        correctSlots: correctSlots(puzzle.board),
        completed: false,
        status: lobby.status,
      };
    });
  },

  /**
   * Authoritatively verifies whether a player's board arrangement is solved.
   * Client NEVER decides completion; server independently validates against
   * the canonical pieceId -> correctPosition mapping.
   */
  async verifyCompletion(
    code: string,
    playerId: string,
    token: string,
    clientGameId?: string | null,
    actionId?: string,
  ): Promise<boolean> {
    const fastLobby = lobbyRepo.getByCodeFast?.(code);
    const lobby =
      fastLobby && fastLobby.status === GameState.PUZZLE
        ? fastLobby
        : await lobbyService.getLobby(code);
    return await withLobbyLock(lobby, async () => {
      const player = findPlayer(lobby, playerId);
      if (!player) throw new GameError("NOT_FOUND", "Player not found.", 404);
      if (!safeEqual(token, player.token)) {
        throw new GameError("FORBIDDEN", "Invalid player token.", 403);
      }
      const claimed = await claimClientAction(
        code,
        lobby,
        player.id,
        "COMPLETE",
        clientGameId,
        actionId,
        player.puzzle?.version ?? lobby.version,
      );
      if (!claimed) return true;
      if (lobby.status !== GameState.PUZZLE) {
        throw new GameError("INVALID_STATE", "The puzzle is not active.", 409);
      }
      const puzzle = player.puzzle;
      if (!puzzle) throw new GameError("INVALID_STATE", "No active puzzle for player.", 409);
      if (puzzle.completed) return true;

      const total = lobby.gridCols * lobby.gridRows;
      const gameId = lobby.currentGameId ?? null;
      if (!isValidBoard(puzzle.board, total)) {
        throw new GameError("INVALID_STATE", "Authoritative puzzle board is invalid.", 409);
      }
      const solved = isSolved(puzzle.board, total);
      if (!solved) {
        throw new GameError("BAD_REQUEST", "Puzzle arrangement is not solved.", 400);
      }

      lobby.version = (lobby.version || 0) + 1;
      puzzle.version = lobby.version;

      console.log("[ACTION_ACCEPTED]", {
        actionId: actionId ?? null,
        gameId,
        playerId,
        actionType: "COMPLETE",
        version: puzzle.version,
      });
      puzzle.completed = true;
      puzzle.completedAt = Date.now();
      await lobbyRepo.put(lobby);

      await manager.sendToPlayer(
        code,
        player.id,
        ev(
          EventType.PUZZLE_MOVE,
          {
            playerId: player.id,
            board: puzzle.board,
            moves: puzzle.moves,
            correctSlots: correctSlots(puzzle.board),
            completed: true,
            pieceCount: total,
            gameId,
            actionId,
            version: puzzle.version,
          },
          lobby.id,
          gameId,
        ),
      );
      await manager.broadcast(
        code,
        ev(
          EventType.PLAYER_COMPLETED,
          { playerId: player.id, at: puzzle.completedAt, gameId },
          lobby.id,
          gameId,
        ),
      );
      await gameService.finish(lobby, player);
      return true;
    });
  },

  /** PUZZLE → FINISHED. Called only from within the lobby lock. */
  async finish(lobby: Lobby, winner: Player): Promise<void> {
    if (lobby.status === GameState.FINISHED) return; // in-process check

    // Database-level atomic winner claiming (single-winner guarantee across instances)
    if (lobby.currentGameId) {
      const { data: claimed, error: claimErr } = await withDbRetry(
        `claim_game_winner(${lobby.currentGameId})`,
        () =>
          supabaseAdmin.rpc("claim_game_winner", {
            p_game_id: lobby.currentGameId,
            p_player_id: winner.id,
          }),
      );

      if (claimErr) {
        console.error("[CLAIM_WINNER_ERROR]", claimErr.message);
      }

      if (claimed === false) {
        console.log(`[WINNER_RACE] Player ${winner.name} (${winner.id}) was preempted by another winner.`);
        return;
      }
    }

    assertTransition(lobby, GameState.FINISHED);
    lobby.status = GameState.FINISHED;
    lobby.winnerId = winner.id;
    lobby.finishedAt = Date.now();
    winner.score += 1;
    clearLobbyTimers(lobby);
    await lobbyRepo.put(lobby);
    const gameId = lobby.currentGameId ?? null;
    await manager.broadcast(
      lobby.code,
      ev(EventType.GAME_FINISHED, resultPayload(lobby), lobby.id, gameId),
    );
  },

  /** FINISHED → MEMORY (PLAY AGAIN – keep players, new image, fresh puzzles). */
  async playAgain(code: string, hostToken: string): Promise<void> {
    const lobby = await lobbyService.getLobby(code);
    await withLobbyLock(lobby, async () => {
      assertHost(lobby, hostToken);
      if (lobby.status === GameState.MEMORY || lobby.status === GameState.PUZZLE) {
        console.log("[PLAY_AGAIN_ALREADY_ACTIVE]", {
          code: code.toUpperCase(),
          gameId: lobby.currentGameId ?? null,
          status: lobby.status,
        });
        return;
      }
      assertTransition(lobby, GameState.MEMORY);
      clearLobbyTimers(lobby);
      for (const p of lobby.players) {
        p.puzzle = null;
        p.eliminated = false;
      }
      const image = imageService.getRandomImage(lobby.usedImageIds);
      lobby.usedImageIds.push(image.id);
      const durationSeconds = lobby.memoryDurationSeconds ?? config.memorySeconds;
      const startedAt = Date.now();
      const endsAt = startedAt + durationSeconds * 1000;
      lobby.status = GameState.MEMORY;
      lobby.memory = { image, startedAt, endsAt, durationSeconds };
      lobby.winnerId = null;
      lobby.finishedAt = null;
      lobby.puzzleStartedAt = null;
      lobby.puzzleEndsAt = null;

      const gameRowId = await createGameRoundRecord(
        code,
        lobby,
        image,
        startedAt,
        endsAt,
        "PLAY_AGAIN",
      );
      if (gameRowId) lobby.currentGameId = gameRowId;

      await lobbyRepo.put(lobby);

      const gameId = lobby.currentGameId ?? null;
      const pieceCount = lobby.gridCols * lobby.gridRows;

      await manager.broadcast(
        code,
        ev(EventType.NEW_GAME, { status: lobby.status, gameId, pieceCount }, lobby.id, gameId),
      );
      await manager.sendToHost(
        code,
        ev(
          EventType.MEMORY_PHASE_STARTED,
          {
            image,
            startedAt,
            endsAt,
            durationSeconds,
            gameId,
            gridCols: lobby.gridCols,
            gridRows: lobby.gridRows,
            pieceCount,
          },
          lobby.id,
          gameId,
        ),
      );
      await manager.broadcastToPlayers(
        code,
        ev(
          EventType.MEMORY_PHASE_STARTED,
          {
            imageName: image.name,
            startedAt,
            endsAt,
            durationSeconds,
            gameId,
            gridCols: lobby.gridCols,
            gridRows: lobby.gridRows,
            pieceCount,
          },
          lobby.id,
          gameId,
        ),
      );
      await manager.broadcast(
        code,
        ev(
          EventType.MEMORY_TIMER_UPDATED,
          { remaining: durationSeconds, endsAt, gameId },
          lobby.id,
          gameId,
        ),
      );
      lobby.timerInterval = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
        void manager.broadcast(
          code,
          ev(EventType.MEMORY_TIMER_UPDATED, { remaining, endsAt, gameId }, lobby.id, gameId),
        );
      }, 1000);
      lobby.endTimeout = setTimeout(() => {
        void gameService.beginPuzzle(code).catch(console.error);
      }, durationSeconds * 1000 + 60);
    });
  },

  /** FINISHED → LOBBY: Authoritatively resets the lobby to clean waiting state with 0 active players. */
  async backToLobby(code: string, hostToken: string): Promise<void> {
    const lobby = await lobbyService.getLobby(code);
    await withLobbyLock(lobby, async () => {
      assertHost(lobby, hostToken);
      if (lobby.status === GameState.LOBBY) {
        console.log("[BACK_TO_LOBBY_ALREADY_ACTIVE]", {
          code: code.toUpperCase(),
          status: lobby.status,
        });
        return;
      }
      clearLobbyTimers(lobby);
      const previousGameId = lobby.currentGameId ?? null;

      // 1. Mark previous game round as permanently finished
      if (lobby.currentGameId) {
        await supabaseAdmin
          .from("games")
          .update({
            state: GameState.FINISHED,
            finished_at: new Date().toISOString(),
          })
          .eq("id", lobby.currentGameId);
      }

      // 2. Authoritatively deactivate all players for this lobby in Supabase
      const { data: lobbyRow } = await supabaseAdmin
        .from("lobbies")
        .select("id")
        .eq("code", code.toUpperCase())
        .maybeSingle();

      if (lobbyRow) {
        await supabaseAdmin
          .from("players")
          .update({ active: false, connected: false })
          .eq("lobby_id", lobbyRow.id);
      }

      // 3. Reset all game & lobby state to a clean waiting state with 0 active players
      lobby.status = GameState.LOBBY;
      lobby.memory = null;
      lobby.puzzleStartedAt = null;
      lobby.puzzleEndsAt = null;
      lobby.puzzleDurationSeconds = undefined;
      lobby.winnerId = null;
      lobby.finishedAt = null;
      lobby.currentGameId = null;
      lobby.players = []; // Clean lobby contains ZERO active players!
      lobby.disconnectTimers = {};

      // 4. Persist clean lobby to Supabase
      await lobbyRepo.put(lobby);

      // 5. Broadcast LOBBY_RESET and GAME_CLOSED so connected clients exit cleanly
      await manager.broadcast(
        code,
        ev(
          EventType.LOBBY_RESET,
          { status: lobby.status, players: [], previousGameId },
          lobby.id,
          null,
        ),
      );
      await manager.broadcast(
        code,
        ev(EventType.GAME_CLOSED, { reason: "HOST_RESET", previousGameId }, lobby.id, null),
      );
      await manager.broadcast(
        code,
        ev(
          EventType.LOBBY_UPDATED,
          { players: [], status: lobby.status, previousGameId },
          lobby.id,
          null,
        ),
      );
    });
  },
};

export { SOURCE_VIEWBOX };
