"use client";

import React from "react";
import { Confetti } from "./Confetti";
import { Avatar } from "./PlayerList";
import { Wordmark, Logo } from "./Brand";
import type { ResultView } from "@/lib/fuzal/useFuzalGame";
import { formatClock } from "@/lib/game/format";
import { GameBadge } from "./game/GameBadge";

export function WinnerScreen({
  result,
  isHost,
  youId,
  onPlayAgain,
  onBackToLobby,
  onNewLobby,
  onExit,
}: {
  result: ResultView;
  isHost: boolean;
  youId?: string;
  onPlayAgain?: () => void;
  onBackToLobby?: () => void;
  onNewLobby?: () => void;
  onExit?: () => void;
}) {
  const winner = result.winner;
  const youWon = Boolean(winner && youId && youId === winner.id);
  const celebrate = isHost || youWon;

  // Find winner's standings entry for moves if available
  const winnerStanding = result.standings.find((s) => s.id === winner?.id);

  return (
    <div className="relative flex min-h-[100dvh] w-full flex-col items-center justify-center gap-6 px-4 py-8 sm:px-6 md:px-12 select-none">
      <Confetti active={celebrate} />

      {/* Atmospheric glow */}
      <div className="pointer-events-none absolute -top-10 h-96 w-96 rounded-full bg-amber-500/15 blur-[130px]" />
      <div className="pointer-events-none absolute -bottom-10 h-96 w-96 rounded-full bg-cyan-500/15 blur-[130px]" />

      {/* Brand Header */}
      <div className="flex flex-col items-center gap-2">
        <Logo size={40} />
        <Wordmark size={32} />
      </div>

      {/* Main Results Card */}
      <div className="glass animate-slide-up relative flex w-full max-w-2xl flex-col items-center gap-5 p-6 sm:p-8 md:p-10 text-center border border-white/15 shadow-[0_20px_70px_rgba(0,0,0,0.7)]">
        {/* Top Winner / Status Podium Banner */}
        {winner ? (
          <div className="flex flex-col items-center gap-2 w-full">
            <div className="relative">
              <span className="animate-winner-glow inline-block text-7xl sm:text-8xl filter drop-shadow-[0_0_25px_rgba(251,191,36,0.6)]">
                🏆
              </span>
              <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-amber-400 px-3 py-0.5 text-[10px] font-black uppercase tracking-widest text-slate-950 shadow-md">
                1ST PLACE
              </span>
            </div>

            <p className="mt-2 text-xs sm:text-sm font-extrabold uppercase tracking-[0.4em] text-amber-300">
              {isHost ? "Match Champion" : youWon ? "Victory!" : "Arena Winner"}
            </p>

            <h1 className="font-display text-5xl sm:text-6xl md:text-7xl font-black text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-400 drop-shadow-[0_0_25px_rgba(251,191,36,0.5)]">
              {winner.name}
            </h1>

            <p className="text-sm sm:text-base font-semibold text-indigo-100/80">
              {youWon
                ? "Incredible solve! You conquered the arena with lightning speed!"
                : isHost
                  ? "Puzzle Master of the Match! 🎉"
                  : `${winner.name} solved the puzzle first!`}
            </p>
          </div>
        ) : result.timeExpired ? (
          <div className="flex flex-col items-center gap-2">
            <span className="text-7xl sm:text-8xl">⌛</span>
            <p className="text-xs sm:text-sm font-extrabold uppercase tracking-[0.4em] text-rose-400">
              Arena Time Expired
            </p>
            <h1 className="font-display text-4xl sm:text-5xl font-black text-white">
              No Puzzle Solved
            </h1>
            <p className="text-sm text-indigo-100/80 max-w-md">
              The 3-minute limit expired before any player fully arranged the puzzle.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <span className="text-7xl sm:text-8xl">🧩</span>
            <p className="text-xs sm:text-sm font-extrabold uppercase tracking-[0.4em] text-cyan-300">
              Round Complete
            </p>
            <h1 className="font-display text-4xl sm:text-5xl font-black text-white">
              Game Over
            </h1>
          </div>
        )}

        {/* Winning Stats Highlight Grid */}
        <div className="grid grid-cols-2 gap-3 w-full max-w-md my-1">
          <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-3.5 flex flex-col items-center">
            <span className="text-[10px] font-extrabold uppercase tracking-[0.25em] text-indigo-200/70">
              {winner ? "Winning Time" : "Round Duration"}
            </span>
            <span className="font-display text-2xl sm:text-3xl font-black text-emerald-400">
              {formatClock(result.durationMs ?? (result.timeExpired ? ((result as any).durationSeconds ? (result as any).durationSeconds * 1000 : 180000) : 0))}
            </span>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-3.5 flex flex-col items-center">
            <span className="text-[10px] font-extrabold uppercase tracking-[0.25em] text-indigo-200/70">
              Winning Moves
            </span>
            <span className="font-display text-2xl sm:text-3xl font-black text-fuchsia-400">
              {winnerStanding?.moves ?? "—"}
            </span>
          </div>
        </div>

        {/* Reveal of completed source image */}
        {result.image && (
          <div className="flex flex-col items-center gap-1.5 my-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-indigo-200/60">
              Solved Puzzle Image
            </span>
            <div className="relative rounded-2xl overflow-hidden p-1 bg-gradient-to-r from-cyan-400/40 via-purple-500/40 to-pink-500/40 shadow-xl">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={result.image.url}
                alt={result.image.name}
                className="h-32 w-32 sm:h-36 sm:w-36 rounded-xl object-cover"
              />
            </div>
            {result.image.name && (
              <span className="text-xs font-semibold text-indigo-200/80">
                {result.image.name}
              </span>
            )}
          </div>
        )}

        {/* Final Standings Leaderboard */}
        <div className="w-full mt-2">
          <div className="flex items-center justify-between px-2 mb-2">
            <span className="text-xs font-extrabold uppercase tracking-[0.3em] text-cyan-300">
              Final Standings
            </span>
            <span className="text-xs font-semibold text-indigo-200/60">
              {result.standings.length} Players
            </span>
          </div>

          <div className="flex flex-col gap-2 w-full">
            {result.standings.map((s, i) => {
              const isFirst = s.id === winner?.id;
              const isYou = s.id === youId;

              return (
                <div
                  key={s.id}
                  className={`flex items-center gap-3 rounded-2xl px-4 py-3 transition-all ${
                    isFirst
                      ? "border-2 border-amber-400/60 bg-gradient-to-r from-amber-500/20 via-yellow-500/10 to-amber-500/20 shadow-[0_0_20px_rgba(251,191,36,0.3)] ring-1 ring-amber-300/30"
                      : isYou
                        ? "border border-cyan-400/40 bg-cyan-500/10"
                        : "border border-white/10 bg-slate-900/50"
                  }`}
                >
                  {/* Rank Badge */}
                  <div className="w-8 flex items-center justify-center">
                    {isFirst ? (
                      <span className="text-xl">👑</span>
                    ) : (
                      <span className="font-mono text-base font-black text-white/50">
                        #{i + 1}
                      </span>
                    )}
                  </div>

                  <Avatar name={s.name} slot={s.slot} size="sm" connected={s.connected} />

                  <div className="flex-1 min-w-0 text-left">
                    <p className="truncate font-bold text-sm sm:text-base text-white">
                      {s.name}
                      {isYou && (
                        <span className="ml-2 rounded bg-cyan-500/20 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-cyan-300">
                          YOU
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] text-indigo-200/60 font-mono">
                      {s.moves ?? 0} moves • {s.correctCount ?? 0} correct
                    </p>
                  </div>

                  {/* Status / Duration */}
                  <div className="text-right">
                    {s.completed ? (
                      <span className="font-mono text-xs sm:text-sm font-black text-emerald-400 flex items-center gap-1">
                        <span>✓</span> {formatClock(s.durationMs ?? 0)}
                      </span>
                    ) : s.eliminated ? (
                      <GameBadge variant="eliminated">ELIMINATED</GameBadge>
                    ) : (
                      <span className="font-mono text-xs text-indigo-200/70">
                        {s.correctCount} pts
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Action Controls: Strictly separated by HOST vs PLAYER */}
        {isHost ? (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3 w-full pt-2">
            <button
              type="button"
              onClick={onPlayAgain}
              className="btn-primary px-6 py-3.5 text-sm sm:text-base font-black flex items-center gap-2"
            >
              <span>🔁</span> PLAY AGAIN
            </button>
            <button
              type="button"
              onClick={onBackToLobby}
              className="btn-secondary px-5 py-3 text-sm font-bold flex items-center gap-2"
            >
              <span>👥</span> BACK TO LOBBY
            </button>
            <button
              type="button"
              onClick={onNewLobby}
              className="btn-ghost px-5 py-3 text-sm font-bold flex items-center gap-2"
            >
              <span>✨</span> NEW ARENA
            </button>
          </div>
        ) : (
          <div className="mt-4 flex flex-col items-center gap-3 w-full pt-2">
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-indigo-200/70">
              Match Complete
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 w-full max-w-sm">
              <button
                type="button"
                onClick={onBackToLobby}
                className="btn-primary w-full py-3 text-sm font-bold flex items-center justify-center gap-2"
              >
                <span>👥</span>
                <span>BACK TO LOBBY</span>
              </button>
              <button
                type="button"
                onClick={onExit}
                className="btn-secondary w-full py-3 text-sm font-bold flex items-center justify-center gap-2"
              >
                <span>🚪</span>
                <span>EXIT MATCH</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
