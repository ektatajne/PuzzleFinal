"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FuzalSocket, type ConnectionState } from "./realtime";
import { pieceUrl, postAction, sessionStore, type ApiError } from "./api";
import {
  EventType,
  GameState,
  type GameEvent,
  type GameState as GameStateType,
} from "@/lib/game/types";
import {
  swapPieces,
  correctSlots as computeCorrect,
  isSolved,
  isValidBoard,
} from "@/lib/game/puzzle";
import {
  getEventGameId,
  getPieceCount,
  isGameState,
  isValidPuzzleBoard,
  shouldAcceptGameEvent,
} from "./stateMachine";

export interface PlayerView {
  id: string;
  name: string;
  connected: boolean;
  score: number;
  slot: number;
}
export interface ProgressView extends PlayerView {
  moves: number;
  correctCount: number;
  completed: boolean;
  eliminated?: boolean;
  durationMs?: number | null;
}
export interface ResultView {
  gameId?: string | null;
  winner: PlayerView | null;
  timeExpired?: boolean;
  finishedAt: number | null;
  durationMs: number | null;
  image: { id: string; url: string; name: string } | null;
  standings: ProgressView[];
}
export interface ClientState {
  code: string;
  lobbyId: string;
  status: GameStateType;
  maxPlayers: number;
  gridCols: number;
  gridRows: number;
  pieceCount: number;
  currentGameId: string | null;
  serverNow: number;
  players: PlayerView[];
  you: { id: string; name: string; score: number } | null;
  isHost: boolean;
  memory: { startedAt: number; endsAt: number; durationSeconds: number } | null;
  image: { id: string; url: string; name: string } | null;
  imageName: string | null;
  puzzle: {
    board: number[];
    moves: number;
    startedAt: number;
    correctSlots: boolean[];
    completed?: boolean;
    completedAt?: number;
    eliminated?: boolean;
    version?: number;
  } | null;
  puzzleStartedAt: number | null;
  puzzleEndsAt?: number | null;
  memoryDurationSeconds?: number | null;
  puzzleDurationSeconds?: number | null;
  puzzleProgress: ProgressView[] | null;
  result: ResultView | null;
}

interface UseOpts {
  code: string;
  kind: "host" | "player";
  hostToken?: string;
  playerId?: string;
  playerToken?: string;
}

function asPositiveInt(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasPlayerAuth(opts: UseOpts): boolean {
  return Boolean(
    opts.kind === "player" &&
      opts.playerId &&
      opts.playerToken &&
      opts.playerToken.length >= 10,
  );
}

function hasSocketAuth(opts: UseOpts): boolean {
  if (opts.kind === "host") {
    return Boolean(opts.hostToken && opts.hostToken.length >= 10);
  }
  return hasPlayerAuth(opts);
}

function makeActionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function actionErrorMeta(error: unknown): { reason: string; status: number | null; code: string | null } {
  const err = error as ApiError;
  return {
    reason: err.code ?? (err.status ? `HTTP_${err.status}` : err.message || "NETWORK_ERROR"),
    status: typeof err.status === "number" ? err.status : null,
    code: typeof err.code === "string" ? err.code : null,
  };
}

function isRetryableActionError(error: unknown): boolean {
  const status = (error as ApiError).status;
  if (typeof status !== "number") return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function postActionUntilSettled(
  code: string,
  body: Record<string, unknown>,
  shouldContinue: () => boolean,
  onRetryableFailure: (error: unknown, attempt: number) => void,
): Promise<Record<string, unknown> | boolean | null> {
  for (let attempt = 1; ; attempt += 1) {
    if (!shouldContinue()) return null;
    try {
      const res = await postAction<Record<string, unknown>>(code, body);
      return res ?? true;
    } catch (error) {
      if (!isRetryableActionError(error)) throw error;
      if (!shouldContinue()) return null;
      onRetryableFailure(error, attempt);
      await delay(Math.min(250 * 2 ** Math.min(attempt - 1, 5), 8000));
    }
  }
}

function countLoadedPieces(srcs: Record<number, string>, total: number): number {
  let loaded = 0;
  for (let i = 0; i < total; i += 1) {
    if (srcs[i]) loaded += 1;
  }
  return loaded;
}

function requiredPieceIds(total: number): number[] {
  return Array.from({ length: total }, (_, pieceId) => pieceId);
}

function normalizePuzzle(
  puzzle: unknown,
  pieceCount: number,
  fallbackStartedAt: number | null,
): ClientState["puzzle"] {
  if (!puzzle || typeof puzzle !== "object") return null;
  const raw = puzzle as Record<string, unknown>;
  if (!isValidPuzzleBoard(raw.board, pieceCount)) return null;
  const board = raw.board;
  return {
    board,
    moves: asNumber(raw.moves, 0),
    startedAt: asNumber(raw.startedAt, fallbackStartedAt ?? Date.now()),
    correctSlots:
      Array.isArray(raw.correctSlots) && raw.correctSlots.length === pieceCount
        ? (raw.correctSlots as boolean[])
        : computeCorrect(board),
    completed: Boolean(raw.completed),
    completedAt: asNullableNumber(raw.completedAt, null) ?? undefined,
    eliminated: Boolean(raw.eliminated),
    version: asPositiveInt(raw.version, 1),
  };
}

function normalizeResult(result: unknown, currentGameId: string | null): ResultView | null {
  if (!result || typeof result !== "object") return null;
  const raw = result as ResultView;
  return {
    ...raw,
    gameId: raw.gameId ?? currentGameId,
    standings: Array.isArray(raw.standings) ? raw.standings : [],
  };
}

function normalizeSnapshot(
  payload: Record<string, unknown>,
  event: GameEvent,
  kind: "host" | "player",
): ClientState {
  const status = isGameState(payload.status) ? payload.status : GameState.LOBBY;
  const gridCols = asPositiveInt(payload.gridCols, 3);
  const gridRows = asPositiveInt(payload.gridRows, 3);
  const pieceCount = getPieceCount(gridCols, gridRows, asPositiveInt(payload.pieceCount, 0));
  const eventGameId = getEventGameId(event);
  const currentGameId = asNullableString(payload.currentGameId) ?? eventGameId;
  const puzzleStartedAt = asNullableNumber(payload.puzzleStartedAt, null);
  const puzzle = normalizePuzzle(payload.puzzle, pieceCount, puzzleStartedAt);

  return {
    code: typeof payload.code === "string" ? payload.code : "",
    lobbyId: typeof payload.lobbyId === "string" ? payload.lobbyId : event.lobbyId ?? "",
    status,
    maxPlayers: asPositiveInt(payload.maxPlayers, 5),
    gridCols,
    gridRows,
    pieceCount,
    currentGameId,
    serverNow: asNumber(payload.serverNow, event.at ?? Date.now()),
    players: Array.isArray(payload.players) ? (payload.players as PlayerView[]) : [],
    you:
      payload.you && typeof payload.you === "object"
        ? (payload.you as ClientState["you"])
        : null,
    isHost:
      typeof payload.isHost === "boolean" ? payload.isHost : kind === "host",
    memory:
      payload.memory && typeof payload.memory === "object"
        ? (payload.memory as ClientState["memory"])
        : null,
    image:
      payload.image && typeof payload.image === "object"
        ? (payload.image as ClientState["image"])
        : null,
    imageName: asNullableString(payload.imageName),
    puzzle,
    puzzleStartedAt: puzzleStartedAt ?? puzzle?.startedAt ?? null,
    puzzleEndsAt: asNullableNumber(payload.puzzleEndsAt, null),
    memoryDurationSeconds: asNullableNumber(payload.memoryDurationSeconds, null),
    puzzleDurationSeconds: asNullableNumber(payload.puzzleDurationSeconds, null),
    puzzleProgress: Array.isArray(payload.puzzleProgress)
      ? (payload.puzzleProgress as ProgressView[])
      : null,
    result: normalizeResult(payload.result, currentGameId),
  };
}

function applyDimensions(next: ClientState, payload: Record<string, unknown>) {
  const gridCols = asPositiveInt(payload.gridCols, next.gridCols);
  const gridRows = asPositiveInt(payload.gridRows, next.gridRows);
  next.gridCols = gridCols;
  next.gridRows = gridRows;
  next.pieceCount = getPieceCount(
    gridCols,
    gridRows,
    asPositiveInt(payload.pieceCount, next.pieceCount),
  );
}

function logClientDiagnostic(
  label: string,
  meta: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
) {
  const logger = level === "warn" ? console.warn : level === "error" ? console.error : console.log;
  logger(`[${label}]`, meta);
}

function logStateRejected(reason: string, event: GameEvent, meta: Record<string, unknown> = {}) {
  logClientDiagnostic("STATE_REJECTED", {
    currentVersion: meta.currentVersion ?? null,
    incomingVersion: Number.isInteger(event.eventId) ? event.eventId : null,
    reason,
    type: event.type,
    eventId: event.eventId ?? null,
    gameId: getEventGameId(event),
    ...meta,
  }, "warn");
}

async function decodeImageSrc(src: string): Promise<void> {
  if (typeof Image === "undefined") return;
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Image decode failed"));
    img.src = src;
  });
  if (typeof img.decode === "function") {
    await img.decode().catch(() => undefined);
  }
}

export { formatClock } from "@/lib/game/format";

export function useFuzalGame(opts: UseOpts) {
  const [state, setState] = useState<ClientState | null>(null);
  const [connState, setConnState] = useState<ConnectionState>("connecting");
  const [toast, setToast] = useState<string | null>(null);
  const [goFlash, setGoFlash] = useState(false);
  const [pieceSrcs, setPieceSrcs] = useState<Record<number, string>>({});
  const [piecesLoading, setPiecesLoading] = useState(false);
  const [piecesError, setPiecesError] = useState<string | null>(null);
  const [loadAttempts, setLoadAttempts] = useState(0);

  const [nowMs, setNowMs] = useState(0);
  const [serverClockOffset, setServerClockOffset] = useState(0);
  const clockOffset = useRef(0);
  const socketRef = useRef<FuzalSocket | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef<ClientState | null>(null);
  const lastAppliedEventId = useRef(0);
  const swapInFlightRef = useRef<string | null>(null);
  const acceptedActionVersions = useRef<Map<string, number | null>>(new Map());

  const commitState = useCallback((next: ClientState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const markActionAccepted = useCallback((actionId: string, version: number | null) => {
    const existingVersion = acceptedActionVersions.current.get(actionId);
    if (existingVersion !== undefined && !(existingVersion === null && version !== null)) {
      return;
    }
    acceptedActionVersions.current.set(actionId, version);
    logClientDiagnostic("ACTION_ACCEPTED", { actionId, version });
    if (swapInFlightRef.current === actionId) {
      swapInFlightRef.current = null;
    }
  }, []);

  const applyEvent = useCallback(
    (event: GameEvent): boolean => {
      if (typeof event.at === "number") {
        const offset = event.at - Date.now();
        clockOffset.current = offset;
        setServerClockOffset(offset);
      }
      const p = (event.payload ?? {}) as Record<string, unknown>;

      if (event.type === EventType.SNAPSHOT) {
        const snapshot = normalizeSnapshot(p, event, opts.kind);
        const prev = stateRef.current;
        if (
          swapInFlightRef.current &&
          prev?.puzzle &&
          snapshot.puzzle &&
          prev.currentGameId &&
          snapshot.currentGameId === prev.currentGameId
        ) {
          const boardDiffers =
            prev.puzzle.board.length !== snapshot.puzzle.board.length ||
            prev.puzzle.board.some((piece, slot) => piece !== snapshot.puzzle!.board[slot]);
          if (
            snapshot.puzzle.moves < prev.puzzle.moves ||
            (snapshot.puzzle.moves === prev.puzzle.moves && boardDiffers)
          ) {
            logStateRejected("STALE_PENDING_ACTION_SNAPSHOT", event, {
              currentVersion: lastAppliedEventId.current,
              currentMoves: prev.puzzle.moves,
              incomingMoves: snapshot.puzzle.moves,
            });
            return false;
          }
        }
        if (
          opts.kind === "player" &&
          prev?.puzzle &&
          snapshot.puzzle &&
          prev.currentGameId &&
          snapshot.currentGameId === prev.currentGameId
        ) {
          const incomingMoves = snapshot.puzzle.moves;
          const currentMoves = prev.puzzle.moves;
          const incomingVersion = snapshot.puzzle.version ?? 0;
          const currentVersion = prev.puzzle.version ?? 0;
          if (incomingMoves < currentMoves || incomingVersion < currentVersion) {
            logClientDiagnostic("REMOTE_BOARD_IGNORED", {
              reason: "STALE_SNAPSHOT",
              currentMoves,
              incomingMoves,
              currentVersion,
              incomingVersion,
            });
            logClientDiagnostic("REMOTE_BOARD_EVENT", {
              status: "IGNORED",
              reason: "STALE_SNAPSHOT",
              currentMoves,
              incomingMoves,
            });
            snapshot.puzzle = prev.puzzle;
          }
        }
        commitState(snapshot);
        if (Number.isInteger(event.eventId) && Number(event.eventId) > lastAppliedEventId.current) {
          lastAppliedEventId.current = Number(event.eventId);
        }
        return true;
      }

      const prev = stateRef.current;
      if (!prev) {
        logStateRejected("NO_SNAPSHOT", event);
        return false;
      }

      const decision = shouldAcceptGameEvent(
        {
          currentStatus: prev.status,
          currentGameId: prev.currentGameId,
          lastAppliedEventId: lastAppliedEventId.current,
        },
        event,
      );
      if (!decision.accept) {
        logStateRejected(decision.reason ?? "UNKNOWN", event, {
          currentVersion: lastAppliedEventId.current,
          current: decision.current,
          incoming: decision.incoming,
        });
        return false;
      }

      const nextCols = asPositiveInt(p.gridCols, prev.gridCols);
      const nextRows = asPositiveInt(p.gridRows, prev.gridRows);
      const nextPieceCount = getPieceCount(
        nextCols,
        nextRows,
        asPositiveInt(p.pieceCount, prev.pieceCount),
      );
      const eventGameId = getEventGameId(event);
      if (
        (event.type === EventType.PUZZLE_STARTED || event.type === EventType.PUZZLE_MOVE) &&
        Array.isArray(p.board) &&
        !isValidPuzzleBoard(p.board, nextPieceCount)
      ) {
        logStateRejected("INVALID_BOARD", event, {
          currentVersion: lastAppliedEventId.current,
          pieceCount: nextPieceCount,
        });
        return false;
      }
      if (
        swapInFlightRef.current &&
        event.type === EventType.PUZZLE_MOVE &&
        Array.isArray(p.board) &&
        prev.puzzle &&
        (!eventGameId || !prev.currentGameId || eventGameId === prev.currentGameId)
      ) {
        const payloadActionId = asNullableString(p.actionId);
        const incomingMoves = asNumber(p.moves, prev.puzzle.moves);
        const incomingBoard = p.board as number[];
        const boardDiffers =
          incomingBoard.length !== prev.puzzle.board.length ||
          incomingBoard.some((piece, slot) => piece !== prev.puzzle!.board[slot]);
        if (
          payloadActionId !== swapInFlightRef.current &&
          (incomingMoves < prev.puzzle.moves ||
            (incomingMoves === prev.puzzle.moves && boardDiffers))
        ) {
          logStateRejected("STALE_PENDING_ACTION_STATE", event, {
            currentVersion: lastAppliedEventId.current,
            currentMoves: prev.puzzle.moves,
            incomingMoves,
          });
          return false;
        }
      }

      const next: ClientState = { ...prev };
      applyDimensions(next, p);
      if (eventGameId) {
        next.currentGameId = eventGameId;
      }

      switch (event.type) {
        case EventType.LOBBY_UPDATED: {
          if (Array.isArray(p.players)) next.players = p.players as PlayerView[];
          if (isGameState(p.status)) next.status = p.status;
          if (p.currentGameId === null) next.currentGameId = null;
          if (typeof p.memorySeconds === "number") next.memoryDurationSeconds = p.memorySeconds;
          if (typeof p.puzzleSeconds === "number") next.puzzleDurationSeconds = p.puzzleSeconds;
          break;
        }
        case EventType.PLAYER_JOINED: {
          const pl = p.player as PlayerView;
          if (pl && !next.players.some((x) => x.id === pl.id)) {
            next.players = [...next.players, pl].sort((a, b) => a.slot - b.slot);
          }
          break;
        }
        case EventType.PLAYER_LEFT: {
          next.players = next.players.filter((x) => x.id !== p.playerId);
          break;
        }
        case EventType.PLAYER_STATUS: {
          const connected = Boolean(p.connected);
          next.players = next.players.map((x) =>
            x.id === p.playerId ? { ...x, connected } : x,
          );
          break;
        }
        case EventType.GAME_STARTED: {
          next.status = GameState.MEMORY;
          next.result = null;
          break;
        }
        case EventType.MEMORY_PHASE_STARTED: {
          next.status = GameState.MEMORY;
          next.result = null;
          next.puzzle = null;
          next.puzzleProgress = null;
          next.puzzleStartedAt = null;
          next.memory = {
            startedAt: asNumber(p.startedAt, Date.now()),
            endsAt: asNumber(p.endsAt, Date.now()),
            durationSeconds: asNumber(p.durationSeconds, 0),
          };
          if (p.image) next.image = p.image as ClientState["image"];
          if (typeof p.imageName === "string") next.imageName = p.imageName;
          break;
        }
        case EventType.MEMORY_TIMER_UPDATED: {
          if (next.memory && typeof p.endsAt === "number") {
            next.memory = { ...next.memory, endsAt: p.endsAt };
          }
          break;
        }
        case EventType.PUZZLE_STARTED: {
          next.status = GameState.PUZZLE;
          next.memory = null;
          next.puzzleStartedAt = asNumber(p.startedAt, next.puzzleStartedAt ?? Date.now());
          const durSec = asNumber(p.durationSeconds, next.puzzleDurationSeconds ?? 180);
          next.puzzleDurationSeconds = durSec;
          next.puzzleEndsAt = asNumber(
            p.endsAt,
            next.puzzleStartedAt + durSec * 1000,
          );
          if (Array.isArray(p.players)) {
            next.puzzleProgress = p.players as ProgressView[];
          }
          if (Array.isArray(p.board)) {
            const eventPlayerId = asNullableString(p.playerId);
            if (opts.kind === "player" && eventPlayerId && eventPlayerId !== opts.playerId) {
              logClientDiagnostic("REMOTE_BOARD_IGNORED", {
                reason: "FOREIGN_PLAYER",
                eventPlayerId,
                myPlayerId: opts.playerId,
                gameId: eventGameId,
              });
              logClientDiagnostic("REMOTE_BOARD_EVENT", {
                status: "IGNORED",
                reason: "FOREIGN_PLAYER",
                eventPlayerId,
                myPlayerId: opts.playerId,
              });
              break;
            }
            logClientDiagnostic("REMOTE_BOARD_EVENT", {
              status: "APPLIED",
              reason: "PUZZLE_STARTED",
              gameId: eventGameId,
              playerId: eventPlayerId ?? opts.playerId,
            });
            const board = p.board as number[];
            const boardChanged =
              !prev.puzzle ||
              prev.puzzle.board.length !== board.length ||
              prev.puzzle.board.some((piece, slot) => piece !== board[slot]);
            next.puzzle = {
              board,
              moves: asNumber(p.moves, 0),
              startedAt: next.puzzleStartedAt,
              correctSlots: computeCorrect(board),
              eliminated: prev.puzzle?.eliminated ?? false,
              completed: Boolean(p.completed),
              version: asPositiveInt(p.version, 1),
            };
            if (boardChanged && opts.kind === "player") {
              setGoFlash(true);
              setTimeout(() => setGoFlash(false), 950);
            }
          }
          break;
        }
        case EventType.PUZZLE_TIMER_UPDATED: {
          if (typeof p.endsAt === "number") {
            next.puzzleEndsAt = p.endsAt;
          }
          break;
        }
        case EventType.PLAYER_ELIMINATED: {
          if (p.playerId === opts.playerId) {
            showToast((p.message as string) ?? "Time's up! You were eliminated.");
            if (next.puzzle) {
              next.puzzle = { ...next.puzzle, eliminated: true };
            }
          }
          if (Array.isArray(next.puzzleProgress)) {
            next.puzzleProgress = next.puzzleProgress.map((pr) =>
              pr.id === p.playerId ? { ...pr, eliminated: true } : pr,
            );
          }
          break;
        }
        case EventType.PUZZLE_MOVE: {
          const payloadActionId = asNullableString(p.actionId);
          const eventPlayerId = asNullableString(p.playerId);
          const incomingVersion = asNullableNumber(p.version, null);

          // 1. Update puzzleProgress for HUD / player roster
          if (eventPlayerId && Array.isArray(next.puzzleProgress)) {
            next.puzzleProgress = next.puzzleProgress.map((pr) =>
              pr.id === eventPlayerId
                ? {
                    ...pr,
                    moves: asNumber(p.moves, pr.moves),
                    correctCount: asNumber(p.correctCount, pr.correctCount),
                    completed: pr.completed || Boolean(p.completed),
                  }
                : pr,
            );
          }

          // 2. If board is present, check scoping and apply ONLY to current player
          if (Array.isArray(p.board)) {
            // Defense-in-depth: Never apply another player's board!
            if (opts.kind === "player" && eventPlayerId && eventPlayerId !== opts.playerId) {
              logClientDiagnostic("REMOTE_BOARD_IGNORED", {
                reason: "FOREIGN_PLAYER",
                eventPlayerId,
                myPlayerId: opts.playerId,
                gameId: eventGameId,
              });
              logClientDiagnostic("REMOTE_BOARD_EVENT", {
                status: "IGNORED",
                reason: "FOREIGN_PLAYER",
                eventPlayerId,
                myPlayerId: opts.playerId,
              });
              break;
            }

            // Reject if gameId does not match current game
            if (eventGameId && next.currentGameId && eventGameId !== next.currentGameId) {
              logClientDiagnostic("REMOTE_BOARD_IGNORED", {
                reason: "GAME_ID_MISMATCH",
                eventGameId,
                currentGameId: next.currentGameId,
              });
              logClientDiagnostic("REMOTE_BOARD_EVENT", {
                status: "IGNORED",
                reason: "GAME_ID_MISMATCH",
              });
              break;
            }

            // Version monotonicity check: Never apply an older version than local current
            const currentVersion = prev.puzzle?.version ?? 0;
            if (incomingVersion !== null && incomingVersion < currentVersion) {
              logClientDiagnostic("REMOTE_BOARD_IGNORED", {
                reason: "STALE_VERSION",
                incomingVersion,
                currentVersion,
                gameId: eventGameId,
              });
              logClientDiagnostic("REMOTE_BOARD_EVENT", {
                status: "IGNORED",
                reason: "STALE_VERSION",
                incomingVersion,
                currentVersion,
              });
              break;
            }

            if (payloadActionId && payloadActionId === swapInFlightRef.current) {
              markActionAccepted(payloadActionId, event.eventId ?? null);
            }

            const board = p.board as number[];
            const isCompleted = Boolean(p.completed);
            const moves = asNumber(p.moves, next.puzzle?.moves ?? 0);
            const version = incomingVersion ?? currentVersion + 1;

            logClientDiagnostic("REMOTE_BOARD_EVENT", {
              status: "APPLIED",
              reason: payloadActionId ? "ACTION_CONFIRMED" : "REMOTE_MOVE",
              actionId: payloadActionId,
              version,
              moves,
              gameId: eventGameId,
            });
            logClientDiagnostic("BOARD_RECONCILE", {
              actionId: payloadActionId,
              gameId: eventGameId,
              playerId: opts.playerId,
              version,
              moves,
            });

            next.puzzle = {
              board,
              moves,
              startedAt: next.puzzle?.startedAt ?? Date.now(),
              correctSlots: computeCorrect(board),
              eliminated: next.puzzle?.eliminated ?? false,
              completed: next.puzzle?.completed || isCompleted,
              completedAt:
                next.puzzle?.completedAt ??
                (isCompleted ? asNumber(p.completedAt, Date.now()) : undefined),
              version,
            };
          }
          break;
        }
        case EventType.PLAYER_COMPLETED: {
          if (p.playerId === opts.playerId && next.puzzle) {
            next.puzzle = {
              ...next.puzzle,
              completed: true,
              completedAt: asNumber(p.at, Date.now()),
            };
          }
          if (Array.isArray(next.puzzleProgress)) {
            next.puzzleProgress = next.puzzleProgress.map((pr) =>
              pr.id === p.playerId ? { ...pr, completed: true } : pr,
            );
          }
          break;
        }
        case EventType.GAME_FINISHED: {
          next.status = GameState.FINISHED;
          next.result = normalizeResult(p, eventGameId ?? next.currentGameId);
          if (Array.isArray(p.standings)) {
            next.players = p.standings as PlayerView[];
          }
          if (p.image) next.image = p.image as ClientState["image"];
          setPieceSrcs({});
          setPiecesLoading(false);
          setPiecesError(null);
          break;
        }
        case EventType.NEW_GAME: {
          next.currentGameId = eventGameId ?? asNullableString(p.gameId);
          next.status = isGameState(p.status) ? p.status : GameState.MEMORY;
          next.result = null;
          next.puzzle = null;
          next.puzzleProgress = null;
          next.image = next.isHost ? next.image : null;
          next.imageName = null;
          next.puzzleStartedAt = null;
          next.puzzleEndsAt = null;
          next.puzzleDurationSeconds = null;
          break;
        }
        case EventType.GAME_TIMEOUT: {
          showToast("Time's up! The 3-minute limit expired.");
          if (next.puzzle && !next.puzzle.completed) {
            next.puzzle = { ...next.puzzle, eliminated: true };
          }
          break;
        }
        case EventType.RESULTS_READY: {
          next.status = GameState.FINISHED;
          if (p) next.result = normalizeResult(p, eventGameId ?? next.currentGameId);
          break;
        }
        case EventType.LOBBY_RESET:
        case EventType.GAME_CLOSED: {
          next.currentGameId = null;
          next.status = GameState.LOBBY;
          next.result = null;
          next.puzzle = null;
          next.puzzleProgress = null;
          next.players = Array.isArray(p.players) ? (p.players as PlayerView[]) : [];
          next.memory = null;
          next.puzzleStartedAt = null;
          next.puzzleEndsAt = null;
          next.puzzleDurationSeconds = null;
          setPieceSrcs({});
          setPiecesLoading(false);
          setPiecesError(null);
          if (opts.kind === "player") {
            try {
              sessionStore.remove("fuzal_player_session");
              sessionStore.remove(`player:${opts.code}`);
            } catch {}
            showToast("Lobby was reset by host. Session closed.");
          }
          break;
        }
        case EventType.ERROR: {
          showToast((p.message as string) ?? "Something went wrong.");
          break;
        }
      }

      commitState(next);
      if (Number.isInteger(event.eventId) && Number(event.eventId) > lastAppliedEventId.current) {
        lastAppliedEventId.current = Number(event.eventId);
      }
      return true;
    },
    [commitState, markActionAccepted, opts.code, opts.kind, opts.playerId, showToast],
  );

  const authReady = useMemo(() => hasSocketAuth(opts), [opts]);

  useEffect(() => {
    if (!authReady) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      queueMicrotask(() => setConnState("session_invalid"));
      return;
    }

    const socket = new FuzalSocket({
      code: opts.code,
      kind: opts.kind,
      hostToken: opts.hostToken,
      playerId: opts.playerId,
      playerToken: opts.playerToken,
      initialLastEventId: lastAppliedEventId.current,
      onEvent: applyEvent,
      onCursorAdvance: (id) => {
        if (id > lastAppliedEventId.current) lastAppliedEventId.current = id;
      },
      onStateChange: setConnState,
      onSessionExpired: () => {
        swapInFlightRef.current = null;
        if (opts.kind === "player") {
          try {
            sessionStore.remove("fuzal_player_session");
            sessionStore.remove(`player:${opts.code}`);
          } catch {}
          showToast("Game session has ended or was reset by the host.");
        } else {
          try {
            sessionStore.remove(`host:${opts.code}`);
          } catch {}
          showToast("Host session has ended or was reset.");
        }
        commitState(null);
      },
    });
    socketRef.current = socket;
    socket.connect();
    return () => {
      if (socketRef.current === socket) socketRef.current = null;
      socket.disconnect();
    };
  }, [
    applyEvent,
    authReady,
    commitState,
    opts.code,
    opts.hostToken,
    opts.kind,
    opts.playerId,
    opts.playerToken,
    showToast,
  ]);

  // 4fps ticker drives server-synchronized countdowns / elapsed time.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const currentNow = nowMs > 0 ? nowMs : state?.serverNow ?? 0;
  const currentServerTime = currentNow + serverClockOffset;
  const serverNow = useCallback(() => currentServerTime, [currentServerTime]);

  const memorySeconds = (() => {
    if (state?.status !== GameState.MEMORY) return 0;
    if (!state?.memory) return 30; // Never treat missing memory data as 0 seconds!
    const ms = state.memory.endsAt - currentServerTime;
    return Math.max(0, Math.ceil(ms / 1000));
  })();

  const lastLoggedSecRef = useRef<number | null>(null);
  useEffect(() => {
    if (state?.status === GameState.MEMORY) {
      if (lastLoggedSecRef.current !== memorySeconds) {
        lastLoggedSecRef.current = memorySeconds;
        logClientDiagnostic("MEMORY_COUNTDOWN", {
          gameId: state.currentGameId,
          memorySeconds,
          currentServerTime,
          endsAt: state.memory?.endsAt ?? null,
        });
      }
    } else {
      lastLoggedSecRef.current = null;
    }
  }, [currentServerTime, memorySeconds, state?.currentGameId, state?.memory?.endsAt, state?.status]);

  const puzzleElapsedMs = (() => {
    if (!state) return 0;
    const start = state.puzzle?.startedAt ?? state.puzzleStartedAt;
    if (!start) return 0;
    const end =
      state.status === GameState.FINISHED
        ? state.result?.finishedAt ?? currentServerTime
        : currentServerTime;
    return Math.max(0, end - start);
  })();

  const puzzleRemainingMs = (() => {
    if (!state) return 0;
    if (state.status !== GameState.PUZZLE) return 0;
    const durMs = (state.puzzleDurationSeconds ?? 180) * 1000;
    const endsAt =
      state.puzzleEndsAt ??
      (state.puzzleStartedAt ? state.puzzleStartedAt + durMs : null);
    if (!endsAt) return durMs;
    return Math.max(0, endsAt - currentServerTime);
  })();

  // Atomic & idempotent client-side countdown expiration trigger:
  // When memorySeconds reaches 0 and game is in MEMORY state, send BEGIN_PUZZLE with stable actionId
  const beginPuzzleActionIdRef = useRef<string | null>(null);
  const beginPuzzleSentRef = useRef<string | null>(null);

  useEffect(() => {
    // Reset refs when gameId changes or status moves out of MEMORY
    if (state?.status !== GameState.MEMORY) {
      beginPuzzleSentRef.current = null;
      beginPuzzleActionIdRef.current = null;
      return;
    }

    if (
      state?.status === GameState.MEMORY &&
      state.memory &&
      memorySeconds <= 0 &&
      state.currentGameId &&
      beginPuzzleSentRef.current !== state.currentGameId
    ) {
      beginPuzzleSentRef.current = state.currentGameId;
      if (!beginPuzzleActionIdRef.current) {
        beginPuzzleActionIdRef.current = makeActionId();
      }
      const actionId = beginPuzzleActionIdRef.current;

      logClientDiagnostic("BEGIN_PUZZLE_REQUEST", {
        gameId: state.currentGameId,
        actionId,
        memorySeconds,
      });

      void postAction<{
        ok?: boolean;
        status?: string;
        gameId?: string;
        startedAt?: number;
        endsAt?: number;
        durationSeconds?: number;
        pieceCount?: number;
        gridCols?: number;
        gridRows?: number;
        board?: number[];
        moves?: number;
      }>(opts.code, {
        type: "BEGIN_PUZZLE",
        actionId,
        playerId: opts.playerId,
      })
        .then((resp) => {
          logClientDiagnostic("BEGIN_PUZZLE_ACCEPTED", {
            gameId: state.currentGameId,
            actionId,
            serverStatus: resp?.status,
          });

          // Reconcile authoritative state directly from response without waiting for SSE!
          if (resp?.status === GameState.PUZZLE) {
            const prev = stateRef.current;
            if (prev && prev.status !== GameState.PUZZLE && prev.status !== GameState.FINISHED) {
              const totalPieces = resp.pieceCount ?? prev.pieceCount;
              const hasValidBoard =
                resp.board && Array.isArray(resp.board) && resp.board.length === totalPieces;
              commitState({
                ...prev,
                status: GameState.PUZZLE,
                memory: null,
                puzzleStartedAt: resp.startedAt ?? prev.puzzleStartedAt ?? Date.now(),
                puzzleDurationSeconds: resp.durationSeconds ?? prev.puzzleDurationSeconds ?? 180,
                puzzleEndsAt:
                  resp.endsAt ??
                  prev.puzzleEndsAt ??
                  (resp.startedAt ?? prev.puzzleStartedAt ?? Date.now()) +
                    (resp.durationSeconds ?? prev.puzzleDurationSeconds ?? 180) * 1000,
                puzzle: hasValidBoard
                  ? {
                      board: resp.board as number[],
                      moves: resp.moves ?? 0,
                      startedAt: resp.startedAt ?? Date.now(),
                      correctSlots: computeCorrect(resp.board as number[]),
                      completed: false,
                      eliminated: false,
                    }
                  : prev.puzzle,
              });
            }
          }
        })
        .catch((err) => {
          logClientDiagnostic(
            "ACTION_REJECTED",
            {
              type: "BEGIN_PUZZLE",
              gameId: state.currentGameId,
              actionId,
              error: (err as Error).message,
            },
            "warn",
          );
          // Allow retry with same actionId
          beginPuzzleSentRef.current = null;
        });
    }
  }, [
    commitState,
    memorySeconds,
    opts.code,
    opts.playerId,
    state?.currentGameId,
    state?.memory,
    state?.status,
  ]);

  const isEliminated = Boolean(
    (state?.status === GameState.PUZZLE && puzzleRemainingMs <= 0 && !state.puzzle?.completed) ||
      state?.puzzle?.eliminated ||
      (state?.status === GameState.FINISHED &&
        state.result &&
        !state.result.winner &&
        !state.puzzle?.completed),
  );

  const currentPieceCount = state
    ? getPieceCount(state.gridCols, state.gridRows, state.pieceCount)
    : 0;
  const currentGameId = state?.currentGameId ?? null;
  const shouldLoadPieces =
    state?.status === GameState.MEMORY || state?.status === GameState.PUZZLE;
  const piecesLoadedCount = useMemo(
    () => countLoadedPieces(pieceSrcs, currentPieceCount),
    [currentPieceCount, pieceSrcs],
  );

  /* ---------------- Actions ---------------- */

  const hostActionInFlightRef = useRef(false);

  const startGame = useCallback(async () => {
    if (!opts.hostToken || hostActionInFlightRef.current) return;
    hostActionInFlightRef.current = true;
    try {
      await postAction(opts.code, { type: "START_GAME", token: opts.hostToken });
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      hostActionInFlightRef.current = false;
    }
  }, [opts.code, opts.hostToken, showToast]);

  const playAgain = useCallback(async () => {
    if (!opts.hostToken || hostActionInFlightRef.current) return;
    hostActionInFlightRef.current = true;
    try {
      await postAction(opts.code, { type: "PLAY_AGAIN", token: opts.hostToken });
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      hostActionInFlightRef.current = false;
    }
  }, [opts.code, opts.hostToken, showToast]);

  const backToLobby = useCallback(async () => {
    if (!opts.hostToken || hostActionInFlightRef.current) return;
    hostActionInFlightRef.current = true;
    try {
      await postAction(opts.code, { type: "BACK_TO_LOBBY", token: opts.hostToken });
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      hostActionInFlightRef.current = false;
    }
  }, [opts.code, opts.hostToken, showToast]);

  const activeInFlightActionsRef = useRef<Set<string>>(new Set());

  const swap = useCallback(
    async (from: number, to: number) => {
      const prev = stateRef.current;
      if (
        !opts.playerId ||
        !opts.playerToken ||
        from === to ||
        isEliminated ||
        !prev?.puzzle ||
        prev.puzzle.completed
      ) {
        return;
      }

      const totalPieces = getPieceCount(prev.gridCols, prev.gridRows, prev.pieceCount);
      if (
        from < 0 ||
        to < 0 ||
        from >= totalPieces ||
        to >= totalPieces ||
        !isValidBoard(prev.puzzle.board, totalPieces)
      ) {
        showToast("Puzzle board is still syncing. Please try again.");
        return;
      }

      const actionId = makeActionId();
      const previousPuzzle = prev.puzzle;
      const nextBoard = swapPieces(prev.puzzle.board, from, to);
      const solved = isSolved(nextBoard, totalPieces);
      const optimisticVersion = (prev.puzzle.version ?? 0) + 1;

      activeInFlightActionsRef.current.add(actionId);
      swapInFlightRef.current = actionId;

      logClientDiagnostic("SWAP_SUBMIT", {
        actionId,
        gameId: prev.currentGameId,
        playerId: opts.playerId,
        from,
        to,
        version: optimisticVersion,
      });
      logClientDiagnostic("ACTION_SENT", {
        actionId,
        gameId: prev.currentGameId,
      });
      logClientDiagnostic("BOARD_MUTATION", {
        cause: "USER_SWAP_OPTIMISTIC",
        actionId,
        gameId: prev.currentGameId,
        before: prev.puzzle.board,
        after: nextBoard,
      });
      commitState({
        ...prev,
        puzzle: {
          ...prev.puzzle,
          board: nextBoard,
          moves: prev.puzzle.moves + 1,
          version: optimisticVersion,
          correctSlots: computeCorrect(nextBoard),
          completed: prev.puzzle.completed || solved,
          completedAt:
            solved && !prev.puzzle.completedAt ? Date.now() : prev.puzzle.completedAt,
        },
      });

      const actionBody = {
        type: "SWAP",
        token: opts.playerToken,
        playerId: opts.playerId,
        from,
        to,
        gameId: prev.currentGameId,
        actionId,
      };

      try {
        const accepted = await postActionUntilSettled(
          opts.code,
          actionBody,
          () =>
            activeInFlightActionsRef.current.has(actionId) &&
            stateRef.current?.currentGameId === prev.currentGameId,
          (error, attempt) => {
            logClientDiagnostic(
              "ACTION_REJECTED",
              {
                actionId,
                gameId: prev.currentGameId,
                retryable: true,
                attempt,
                ...actionErrorMeta(error),
              },
              "warn",
            );
            if (attempt === 1) {
              showToast("Move is syncing. We'll keep retrying.");
            }
          },
        );
        if (accepted) {
          const res = typeof accepted === "object" && accepted !== null ? accepted : null;
          const serverVersion = asNullableNumber(res?.version, null) ?? optimisticVersion;
          const serverMoves = asNullableNumber(res?.moves, null) ?? prev.puzzle.moves + 1;

          logClientDiagnostic("SWAP_RESPONSE", {
            actionId,
            gameId: prev.currentGameId,
            playerId: opts.playerId,
            success: true,
            version: serverVersion,
            moves: serverMoves,
          });
          logClientDiagnostic("BOARD_RECONCILE", {
            actionId,
            gameId: prev.currentGameId,
            playerId: opts.playerId,
            version: serverVersion,
            moves: serverMoves,
          });
          activeInFlightActionsRef.current.delete(actionId);
          markActionAccepted(actionId, serverVersion);
        } else {
          activeInFlightActionsRef.current.delete(actionId);
          if (swapInFlightRef.current === actionId) {
            swapInFlightRef.current = null;
          }
        }
      } catch (e) {
        logClientDiagnostic(
          "SWAP_RESPONSE",
          {
            actionId,
            gameId: prev.currentGameId,
            playerId: opts.playerId,
            success: false,
            ...actionErrorMeta(e),
          },
          "warn",
        );
        logClientDiagnostic(
          "ACTION_REJECTED",
          {
            actionId,
            gameId: prev.currentGameId,
            retryable: false,
            ...actionErrorMeta(e),
          },
          "warn",
        );
        activeInFlightActionsRef.current.delete(actionId);
        const current = stateRef.current;
        if (
          activeInFlightActionsRef.current.size === 0 &&
          current?.status === GameState.PUZZLE &&
          current.currentGameId === prev.currentGameId
        ) {
          commitState({ ...current, puzzle: previousPuzzle });
        }
        showToast((e as Error).message);
        if (swapInFlightRef.current === actionId) {
          swapInFlightRef.current = null;
        }
      }
    },
    [
      commitState,
      isEliminated,
      markActionAccepted,
      opts.code,
      opts.playerId,
      opts.playerToken,
      showToast,
    ],
  );

  /* ------------- Preload puzzle pieces with retry & validation ------------- */

  const retryLoadPieces = useCallback(() => {
    setPiecesError(null);
    setLoadAttempts((c) => c + 1);
  }, []);

  const hasAuth = hasPlayerAuth(opts);
  useEffect(() => {
    if (!shouldLoadPieces || !hasAuth || !opts.code || currentPieceCount <= 0) {
      return;
    }

    const total = currentPieceCount;
    const ids = requiredPieceIds(total);
    const gameId = currentGameId;
    let cancelled = false;
    const created: string[] = [];
    const loaded = new Set<number>();
    let failed = 0;

    const recordProgress = () => {
      const ready = loaded.size === total && failed === 0;
      logClientDiagnostic("PUZZLE_LOADING", {
        gameId,
        pieceCount: total,
        loaded: loaded.size,
        failed,
        ready,
      });
      if (ready) {
        logClientDiagnostic("PUZZLE_PRELOAD_READY", {
          gameId,
          pieceCount: total,
          loaded: loaded.size,
          failed,
        });
        logClientDiagnostic("PUZZLE_READY", {
          gameId,
          pieceCount: total,
          loaded: loaded.size,
          failed,
        });
      }
    };

    async function acceptPiece(pieceId: number, src: string) {
      await decodeImageSrc(src);
      if (cancelled) return;
      loaded.add(pieceId);
      setPieceSrcs((prev) => ({ ...prev, [pieceId]: src }));
      recordProgress();
      if (loaded.size === total && failed === 0) {
        setPiecesLoading(false);
      }
    }

    async function loadBatch(): Promise<boolean> {
      logClientDiagnostic("PUZZLE_PRELOAD_START", {
        gameId,
        pieceCount: total,
        phase: state?.status,
      });
      const batchUrl = `/api/lobbies/${opts.code}/pieces?p=${encodeURIComponent(
        opts.playerId!,
      )}&t=${encodeURIComponent(opts.playerToken!)}`;
      const batchRes = await fetch(batchUrl);
      if (!batchRes.ok) return false;
      const batchData = await batchRes.json();
      const pieces = batchData?.pieces as Record<string, string> | undefined;
      if (!batchData?.ok || !pieces) return false;
      if (!ids.every((pieceId) => typeof pieces[pieceId] === "string")) return false;

      await Promise.all(ids.map((pieceId) => acceptPiece(pieceId, pieces[pieceId])));
      return loaded.size === total;
    }

    async function fetchTileWithRetry(pieceId: number, maxRetries = 3): Promise<string> {
      let lastErr = "";
      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        if (cancelled) throw new Error("Cancelled");
        try {
          const url = pieceUrl(opts.code!, pieceId, opts.playerId!, opts.playerToken!);
          const res = await fetch(url);
          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            lastErr = `HTTP ${res.status}: ${errText}`;
            await new Promise((r) => setTimeout(r, 150 * attempt));
            continue;
          }
          const cType = res.headers.get("content-type") ?? "";
          if (!cType.includes("image")) {
            lastErr = `Expected image content-type, got: ${cType}`;
            await new Promise((r) => setTimeout(r, 150 * attempt));
            continue;
          }
          const blob = await res.blob();
          const objectUrl = URL.createObjectURL(blob);
          created.push(objectUrl);
          return objectUrl;
        } catch (e) {
          lastErr = (e as Error).message;
          await new Promise((r) => setTimeout(r, 150 * attempt));
        }
      }
      throw new Error(`Failed to load piece #${pieceId} (${lastErr})`);
    }

    async function preload() {
      setPieceSrcs({});
      setPiecesLoading(true);
      setPiecesError(null);
      recordProgress();

      try {
        const loadedFromBatch = await loadBatch();
        if (!loadedFromBatch) {
          await Promise.all(
            ids.map((pieceId) =>
              fetchTileWithRetry(pieceId, 3)
                .then((src) => acceptPiece(pieceId, src))
                .catch((err) => {
                  failed += 1;
                  recordProgress();
                  throw err;
                }),
            ),
          );
        }

        if (cancelled) return;
        if (loaded.size !== total) {
          throw new Error(`Loaded ${loaded.size}/${total} puzzle pieces.`);
        }
        setPiecesLoading(false);
      } catch (err) {
        if (!cancelled) {
          console.error("[PRELOAD_ERROR]", err);
          setPiecesError((err as Error).message);
          setPiecesLoading(false);
        }
      }
    }

    void preload();

    return () => {
      cancelled = true;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [
    currentGameId,
    currentPieceCount,
    hasAuth,
    loadAttempts,
    opts.code,
    opts.playerId,
    opts.playerToken,
    shouldLoadPieces,
  ]);

  const exitGame = useCallback(() => {
    socketRef.current?.disconnect();
    swapInFlightRef.current = null;
    acceptedActionVersions.current.clear();
    try {
      sessionStore.remove("fuzal_player_session");
      sessionStore.remove(`player:${opts.code}`);
    } catch {}
    lastAppliedEventId.current = 0;
    commitState(null);
  }, [commitState, opts.code]);

  return {
    state,
    connState,
    toast,
    goFlash,
    serverNow,
    memorySeconds,
    puzzleElapsedMs,
    puzzleRemainingMs,
    isEliminated,
    pieceSrcs,
    piecesLoading,
    piecesLoadedCount,
    piecesError,
    retryLoadPieces,
    actions: { startGame, swap, playAgain, backToLobby, exitGame },
  };
}
