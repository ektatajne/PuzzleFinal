"use client";

import React, { useState } from "react";
import { GameBadge } from "@/components/game/GameBadge";
import { config as defaultConfig } from "@/lib/game/config";
import { formatClock } from "@/lib/game/format";

export function ConfigTab({
  maxPlayers: propMaxPlayers,
  onMaxPlayersChange,
  gridSize: propGridSize,
  currentGridSize,
  onGridSizeChange,
  memorySeconds: propMemorySeconds,
  onMemorySecondsChange,
  puzzleSeconds: propPuzzleSeconds,
  onPuzzleSecondsChange,
  onSave,
}: {
  maxPlayers?: number;
  onMaxPlayersChange?: (n: number) => void;
  gridSize?: number;
  currentGridSize?: number;
  onGridSizeChange?: (n: number) => void;
  memorySeconds?: number;
  onMemorySecondsChange?: (n: number) => void;
  puzzleSeconds?: number;
  onPuzzleSecondsChange?: (n: number) => void;
  onSave?: () => void;
} = {}) {
  const [internalMaxPlayers, setInternalMaxPlayers] = useState(propMaxPlayers ?? defaultConfig.defaultCapacity ?? 8);
  const [internalGridSize, setInternalGridSize] = useState(propGridSize ?? currentGridSize ?? defaultConfig.gridCols ?? 3);
  const [internalMemorySeconds, setInternalMemorySeconds] = useState(propMemorySeconds ?? defaultConfig.memorySeconds ?? 30);
  const [internalPuzzleSeconds, setInternalPuzzleSeconds] = useState(propPuzzleSeconds ?? defaultConfig.puzzleSeconds ?? 180);

  const maxPlayers = propMaxPlayers ?? internalMaxPlayers;
  const setMaxPlayers = onMaxPlayersChange ?? setInternalMaxPlayers;

  const gridSize = propGridSize ?? currentGridSize ?? internalGridSize;
  const setGridSize = onGridSizeChange ?? setInternalGridSize;

  const memorySeconds = propMemorySeconds ?? internalMemorySeconds;
  const setMemorySeconds = onMemorySecondsChange ?? setInternalMemorySeconds;

  const puzzleSeconds = propPuzzleSeconds ?? internalPuzzleSeconds;
  const setPuzzleSeconds = onPuzzleSecondsChange ?? setInternalPuzzleSeconds;
  return (
    <div className="flex w-full flex-col gap-6 select-none max-w-4xl">
      {/* Header */}
      <div className="glass p-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <GameBadge variant="ready">ARENA CONFIGURATION</GameBadge>
            <span className="text-xs text-indigo-200/60 font-mono">Host Defaults</span>
          </div>
          <h2 className="font-display text-2xl sm:text-3xl font-black text-white uppercase tracking-wider mt-1">
            Arena Rules &amp; Capacity
          </h2>
          <p className="text-xs sm:text-sm text-indigo-200/70">
            Set player capacity limits, memorization duration, and puzzle solve timers for upcoming games.
          </p>
        </div>

        {onSave && (
          <button
            type="button"
            onClick={onSave}
            className="btn-primary px-5 py-2.5 text-xs sm:text-sm font-black flex items-center gap-2"
          >
            <span>💾</span>
            <span>Save Preferences</span>
          </button>
        )}
      </div>

      {/* Configuration Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* 1. Player Capacity Config */}
        <div className="glass p-6 flex flex-col gap-4 border border-cyan-400/20">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base sm:text-lg font-bold text-white uppercase">
              Player Capacity
            </h3>
            <span className="text-xs font-mono font-bold text-cyan-300 bg-cyan-500/15 px-2 py-0.5 rounded-full border border-cyan-400/30">
              1–100 Allowed
            </span>
          </div>
          <p className="text-xs text-indigo-200/70">
            Maximum number of participants allowed in this arena lobby simultaneously.
          </p>

          <div className="flex items-center gap-3 my-2">
            <button
              type="button"
              onClick={() => setMaxPlayers(Math.max(1, maxPlayers - 1))}
              className="h-10 w-10 rounded-xl bg-slate-900 border border-white/15 text-white text-lg font-black hover:bg-white/10 active:scale-95 transition-all"
            >
              −
            </button>
            <div className="flex-1 flex items-center justify-center rounded-xl bg-slate-900/90 border border-cyan-400/40 py-2">
              <span className="font-display text-3xl font-black text-cyan-300 font-mono">
                {maxPlayers}
              </span>
              <span className="text-xs font-bold text-white/50 ml-1.5 uppercase">PLAYERS</span>
            </div>
            <button
              type="button"
              onClick={() => setMaxPlayers(Math.min(100, maxPlayers + 1))}
              className="h-10 w-10 rounded-xl bg-slate-900 border border-white/15 text-white text-lg font-black hover:bg-white/10 active:scale-95 transition-all"
            >
              +
            </button>
          </div>

          <div className="flex items-center gap-1.5 text-[11px] text-indigo-200/60 font-mono">
            <span>💡 Recommended:</span>
            <span>8 players for standard event matches</span>
          </div>
        </div>

        {/* 2. Grid Size Config */}
        <div className="glass p-6 flex flex-col gap-4 border border-purple-400/20">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base sm:text-lg font-bold text-white uppercase">
              Default Grid Size
            </h3>
            <span className="font-mono text-xs font-bold text-purple-300 bg-purple-500/15 px-2 py-0.5 rounded-full border border-purple-400/30">
              {gridSize}×{gridSize} ({gridSize * gridSize} Pcs)
            </span>
          </div>
          <p className="text-xs text-indigo-200/70">
            Initial puzzle grid size selected when creating new arenas.
          </p>

          <div className="grid grid-cols-4 gap-2 my-2">
            {[2, 3, 4, 5, 6, 7, 8].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setGridSize(n)}
                className={`py-2 rounded-xl text-xs font-bold transition-all ${
                  gridSize === n
                    ? "bg-cyan-500 text-slate-950 font-black shadow-[0_0_12px_rgba(34,211,238,0.5)] scale-[1.03]"
                    : "bg-slate-900/80 border border-white/10 text-indigo-200/70 hover:text-white"
                }`}
              >
                {n}×{n} ({n * n})
              </button>
            ))}
          </div>
        </div>

        {/* 3. Memory Phase Duration */}
        <div className="glass p-6 flex flex-col gap-4 border border-white/10">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base sm:text-lg font-bold text-white uppercase">
              Memory Phase Duration
            </h3>
            <span className="font-mono text-xs font-bold text-amber-300 bg-amber-500/15 px-2 py-0.5 rounded-full border border-amber-400/30">
              {formatClock(memorySeconds * 1000)}
            </span>
          </div>
          <p className="text-xs text-indigo-200/70">
            Time players and audience have to memorize the original puzzle image on the big screen.
          </p>

          <div className="grid grid-cols-4 gap-2 my-1">
            {[15, 30, 45, 60, 120, 180, 300].map((sec) => (
              <button
                key={sec}
                type="button"
                onClick={() => setMemorySeconds(sec)}
                className={`py-2 rounded-xl text-xs font-bold transition-all ${
                  memorySeconds === sec
                    ? "bg-amber-400 text-slate-950 font-black shadow-[0_0_12px_rgba(251,191,36,0.5)]"
                    : "bg-slate-900/80 border border-white/10 text-indigo-200/70 hover:text-white"
                }`}
              >
                {formatClock(sec * 1000)}
              </button>
            ))}
          </div>
        </div>

        {/* 4. Puzzle Phase Duration */}
        <div className="glass p-6 flex flex-col gap-4 border border-white/10">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base sm:text-lg font-bold text-white uppercase">
              Puzzle Phase Limit
            </h3>
            <span className="font-mono text-xs font-bold text-fuchsia-300 bg-fuchsia-500/15 px-2 py-0.5 rounded-full border border-fuchsia-400/30">
              {formatClock(puzzleSeconds * 1000)}
            </span>
          </div>
          <p className="text-xs text-indigo-200/70">
            Maximum round time limit before unsolved players are eliminated.
          </p>

          <div className="grid grid-cols-4 gap-2 my-1">
            {[
              { sec: 120, label: "02:00" },
              { sec: 150, label: "02:30" },
              { sec: 180, label: "03:00" },
              { sec: 300, label: "05:00" },
              { sec: 600, label: "10:00" },
              { sec: 900, label: "15:00" },
              { sec: 1200, label: "20:00" },
              { sec: 1800, label: "30:00" },
            ].map((opt) => (
              <button
                key={opt.sec}
                type="button"
                onClick={() => setPuzzleSeconds(opt.sec)}
                className={`py-2 rounded-xl text-xs font-bold transition-all ${
                  puzzleSeconds === opt.sec
                    ? "bg-fuchsia-500 text-white font-black shadow-[0_0_12px_rgba(217,70,239,0.5)]"
                    : "bg-slate-900/80 border border-white/10 text-indigo-200/70 hover:text-white"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
