/**
 * Fuzal domain models & event contracts.
 *
 * These are the TypeScript twins of the Pydantic models used by the reference
 * FastAPI service (see /backend/app/models). Runtime validation is done with
 * Zod so malformed WebSocket / REST payloads are rejected before touching the
 * authoritative game state.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Enums / state machine                                               */
/* ------------------------------------------------------------------ */

/** LOBBY → MEMORY → PUZZLE → FINISHED → (LOBBY | MEMORY) */
export const GameState = {
  LOBBY: "LOBBY",
  MEMORY: "MEMORY",
  PUZZLE: "PUZZLE",
  FINISHED: "FINISHED",
} as const;
export type GameState = (typeof GameState)[keyof typeof GameState];

export const VALID_TRANSITIONS: Record<GameState, GameState[]> = {
  LOBBY: [GameState.MEMORY],
  MEMORY: [GameState.PUZZLE],
  PUZZLE: [GameState.FINISHED],
  FINISHED: [GameState.LOBBY, GameState.MEMORY],
};

export const PlayerConnection = {
  CONNECTED: "CONNECTED",
  DISCONNECTED: "DISCONNECTED",
} as const;
export type PlayerConnection =
  (typeof PlayerConnection)[keyof typeof PlayerConnection];

/* ------------------------------------------------------------------ */
/* Entity types                                                        */
/* ------------------------------------------------------------------ */

export interface PuzzleInstance {
  /** board[slotIndex] = pieceId (correct pieceId === slotIndex) */
  board: number[];
  moves: number;
  startedAt: number;
  completed: boolean;
  completedAt: number | null;
  eliminated?: boolean;
  version?: number;
}

export interface Player {
  id: string;
  name: string;
  token: string;
  joinedAt: number;
  connectionStatus: PlayerConnection;
  score: number;
  slot: number;
  puzzle: PuzzleInstance | null;
  eliminated?: boolean;
}

export interface ImageMeta {
  id: string;
  url: string;
  name: string;
  slug?: string;
}

export interface MemoryPhase {
  image: ImageMeta;
  startedAt: number;
  endsAt: number;
  durationSeconds: number;
}

export interface Lobby {
  id: string; // e.g. FZ-A82K
  code: string; // e.g. A82K (used in /join/{code})
  hostToken: string;
  status: GameState;
  players: Player[];
  maxPlayers: number;
  gridCols: number;
  gridRows: number;
  pieceCount?: number;
  version?: number;
  currentGameId?: string | null;
  memory: MemoryPhase | null;
  puzzleStartedAt: number | null;
  puzzleEndsAt?: number | null;
  memoryDurationSeconds?: number;
  puzzleDurationSeconds?: number;
  winnerId: string | null;
  finishedAt: number | null;
  /** per-lobby async mutex (chained promises) – guarantees atomic winner */
  lockChain: Promise<unknown>;
  timerInterval: ReturnType<typeof setInterval> | null;
  endTimeout: ReturnType<typeof setTimeout> | null;
  disconnectTimers: Record<string, ReturnType<typeof setTimeout>>;
  usedImageIds: string[];
  createdAt: number;
}

export const EventType = {
  SNAPSHOT: "SNAPSHOT",
  ERROR: "ERROR",
  PLAYER_JOINED: "PLAYER_JOINED",
  PLAYER_LEFT: "PLAYER_LEFT",
  PLAYER_STATUS: "PLAYER_STATUS",
  LOBBY_UPDATED: "LOBBY_UPDATED",
  GAME_STARTED: "GAME_STARTED",
  MEMORY_PHASE_STARTED: "MEMORY_PHASE_STARTED",
  MEMORY_TIMER_UPDATED: "MEMORY_TIMER_UPDATED",
  PUZZLE_STARTED: "PUZZLE_STARTED",
  PUZZLE_TIMER_UPDATED: "PUZZLE_TIMER_UPDATED",
  PUZZLE_MOVE: "PUZZLE_MOVE",
  PLAYER_COMPLETED: "PLAYER_COMPLETED",
  PLAYER_ELIMINATED: "PLAYER_ELIMINATED",
  GAME_FINISHED: "GAME_FINISHED",
  GAME_TIMEOUT: "GAME_TIMEOUT",
  RESULTS_READY: "RESULTS_READY",
  NEW_GAME: "NEW_GAME",
  LOBBY_RESET: "LOBBY_RESET",
  GAME_CLOSED: "GAME_CLOSED",
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

export interface GameEvent<T = unknown> {
  type: EventType;
  at: number;
  eventId?: number;
  lobbyId?: string;
  gameId?: string | null;
  payload: T;
}

/* ------------------------------------------------------------------ */
/* REST validation schemas                                            */
/* ------------------------------------------------------------------ */

export const LOBBY_CODE_RE = /^[A-Z0-9]{4}$/;
export const PLAYER_ID_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|p_[A-Za-z0-9]{10,})$/i;
export const NAME_RE = /^[\p{L}\p{N} _.\-']{1,16}$/u;

export const SUPPORTED_GRID_SIZES = [2, 3, 4, 5, 6, 7, 8] as const;
export type SupportedGridSize = (typeof SUPPORTED_GRID_SIZES)[number];

export function isSupportedGridSize(n: unknown): n is SupportedGridSize {
  return typeof n === "number" && Number.isInteger(n) && n >= 2 && n <= 8;
}

export const createLobbySchema = z
  .object({
    gridSize: z.number().int().min(2).max(8).optional(),
    gridCols: z.number().int().min(2).max(8).optional(),
    gridRows: z.number().int().min(2).max(8).optional(),
    maxPlayers: z.number().int().min(1).max(100).optional(),
    memorySeconds: z.number().int().min(5).max(600).optional(),
    puzzleSeconds: z.number().int().min(10).max(3600).optional(),
    imageId: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.gridSize !== undefined && (data.gridSize < 2 || data.gridSize > 8)) {
        return false;
      }
      if (data.gridCols !== undefined && data.gridRows !== undefined) {
        return data.gridCols === data.gridRows;
      }
      if (data.gridSize !== undefined && data.gridCols !== undefined) {
        return data.gridSize === data.gridCols;
      }
      if (data.gridSize !== undefined && data.gridRows !== undefined) {
        return data.gridSize === data.gridRows;
      }
      return true;
    },
    {
      message: "Only square grids (2x2 through 8x8) are supported for new games.",
    },
  );

export const updateLobbySchema = z.object({
  token: z.string(),
  gridSize: z.number().int().min(2).max(8).optional(),
  maxPlayers: z.number().int().min(1).max(100).optional(),
  memorySeconds: z.number().int().min(5).max(600).optional(),
  puzzleSeconds: z.number().int().min(10).max(3600).optional(),
});

export interface GameHistoryItem {
  id: string;
  lobbyCode: string;
  date: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  durationFormatted: string;
  puzzleName: string;
  puzzleSlug?: string;
  gridSize: number;
  gridDisplay: string;
  pieceCount: number;
  playerCount: number;
  winnerName: string | null;
  winnerMoves: number | null;
  winnerDurationFormatted: string | null;
  status: string;
}

export interface HistoricalPlayerParticipation {
  id: string;
  name: string;
  slot: number;
  score: number;
  moves: number;
  correctSlots: number;
  completed: boolean;
  durationMs: number | null;
  durationFormatted: string;
  finalStatus: "SOLVED" | "ELIMINATED" | "DID_NOT_FINISH";
}

export interface GameHistoryDetail {
  id: string;
  lobbyCode: string;
  status: string;
  gridSize: number;
  gridDisplay: string;
  pieceCount: number;
  startedAt: string | null;
  endedAt: string | null;
  durationFormatted: string;
  puzzle: {
    id: string;
    name: string;
    url?: string;
  };
  winner: {
    name: string;
    moves: number | null;
    durationFormatted: string | null;
  } | null;
  standings: HistoricalPlayerParticipation[];
  players: HistoricalPlayerParticipation[];
}

export interface HostAnalyticsOverview {
  totalGames: number;
  totalPlayers: number;
  totalCompletions: number;
  activeLobbies: number;
  avgSolveTimeMs: number | null;
  avgSolveTimeFormatted: string;
  bestSolveTimeMs: number | null;
  bestSolveTimeFormatted: string;
  recentGames: GameHistoryItem[];
}

export interface PuzzleImageDef {
  id: string;
  name: string;
  slug: string;
  url: string;
  width: number;
  height: number;
  supportedGrids: number[];
  active: boolean;
  createdAt: string;
  usageCount: number;
}

export const joinSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Please enter your name")
    .max(16, "Name must be 16 characters or fewer")
    .regex(NAME_RE, "Name contains invalid characters"),
});

const actionBase = z.object({
  token: z.string().min(10),
});
const clientActionFields = {
  actionId: z.string().trim().min(8).max(100).optional(),
  gameId: z.string().trim().min(1).max(100).nullable().optional(),
};

export const startGameAction = actionBase.extend({
  type: z.literal("START_GAME"),
});
export const swapAction = actionBase.extend({
  type: z.literal("SWAP"),
  playerId: z.string().min(3),
  from: z.number().int().min(0).max(63),
  to: z.number().int().min(0).max(63),
  ...clientActionFields,
});
export const completeAction = actionBase.extend({
  type: z.literal("COMPLETE"),
  playerId: z.string().min(3),
  ...clientActionFields,
});
export const playAgainAction = actionBase.extend({
  type: z.literal("PLAY_AGAIN"),
});
export const backToLobbyAction = actionBase.extend({
  type: z.literal("BACK_TO_LOBBY"),
});
export const beginPuzzleAction = z.object({
  type: z.literal("BEGIN_PUZZLE"),
  token: z.string().optional(),
  playerId: z.string().optional(),
  ...clientActionFields,
});

export const actionSchema = z.union([
  startGameAction,
  beginPuzzleAction,
  swapAction,
  completeAction,
  playAgainAction,
  backToLobbyAction,
]);
export type ActionInput = z.infer<typeof actionSchema>;
