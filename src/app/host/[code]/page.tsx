"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useFuzalGame } from "@/lib/fuzal/useFuzalGame";
import { formatClock } from "@/lib/game/format";
import { createLobby, sessionStore, updateLobbyConfig } from "@/lib/fuzal/api";
import { Wordmark, Logo } from "@/components/Brand";
import { ConnBanner } from "@/components/ConnBanner";
import { GameShell } from "@/components/game/GameShell";
import { ControlRoomTopBar } from "@/components/host/ControlRoomTopBar";
import { ControlRoomNav, HostTab } from "@/components/host/ControlRoomNav";
import { LiveGameTab } from "@/components/host/LiveGameTab";
import { OverviewTab } from "@/components/host/OverviewTab";
import { PlayersTab } from "@/components/host/PlayersTab";
import { HistoryTab } from "@/components/host/HistoryTab";
import { PuzzleLibraryTab } from "@/components/host/PuzzleLibraryTab";
import { ConfigTab } from "@/components/host/ConfigTab";

function HostPageContent() {
  const params = useParams<{ code: string }>();
  const code = String(params.code).toUpperCase();
  const router = useRouter();
  const search = useSearchParams();

  const [activeTab, setActiveTab] = useState<HostTab>(() => {
    const t = search.get("tab") as HostTab;
    if (["overview", "live", "players", "history", "puzzles", "config"].includes(t)) {
      return t;
    }
    return "live";
  });

  const [token] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const sp = new URLSearchParams(window.location.search);
    const qt = sp.get("token");
    if (qt) {
      sessionStore.set(`host:${code}`, { token: qt });
      window.history.replaceState(null, "", `/host/${code}`);
      return qt;
    }
    const stored = sessionStore.get<{ token: string }>(`host:${code}`);
    return stored?.token ?? null;
  });

  const [badHost] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const sp = new URLSearchParams(window.location.search);
    const qt = sp.get("token");
    if (qt) return false;
    const stored = sessionStore.get<{ token: string }>(`host:${code}`);
    return !stored?.token;
  });

  const game = useFuzalGame(token ? { code, kind: "host", hostToken: token } : { code, kind: "host" });
  const { state, connState, toast, memorySeconds, puzzleElapsedMs, puzzleRemainingMs, actions } = game;

  const [configMaxPlayers, setConfigMaxPlayers] = useState<number>(8);
  const [configGridSize, setConfigGridSize] = useState<number>(3);
  const [configMemorySeconds, setConfigMemorySeconds] = useState<number>(30);
  const [configPuzzleSeconds, setConfigPuzzleSeconds] = useState<number>(180);

  useEffect(() => {
    if (state) {
      if (state.maxPlayers) setConfigMaxPlayers(state.maxPlayers);
      if (state.gridCols) setConfigGridSize(state.gridCols);
      if (state.memoryDurationSeconds) setConfigMemorySeconds(state.memoryDurationSeconds);
      if (state.puzzleDurationSeconds) setConfigPuzzleSeconds(state.puzzleDurationSeconds);
    }
  }, [state?.maxPlayers, state?.gridCols, state?.memoryDurationSeconds, state?.puzzleDurationSeconds]);

  async function handleSaveConfig() {
    if (!token) return;
    try {
      await updateLobbyConfig(code, token, {
        maxPlayers: configMaxPlayers,
        gridSize: configGridSize,
        memorySeconds: configMemorySeconds,
        puzzleSeconds: configPuzzleSeconds,
      });
    } catch (err: any) {
      console.error("Failed to save config:", err);
    }
  }

  async function newLobby() {
    const lobby = await createLobby({
      gridSize: state?.gridCols ?? 3,
      maxPlayers: state?.maxPlayers ?? 8,
    });
    sessionStore.set(`host:${lobby.code}`, { token: lobby.hostToken });
    router.push(`/host/${lobby.code}`);
  }

  function handleOpenDisplay() {
    window.open(`/display/${code}`, "_blank", "noopener,noreferrer");
  }

  if (badHost) {
    return (
      <GameShell maxWidth="max-w-md">
        <div className="glass w-full p-8 text-center flex flex-col items-center gap-4">
          <div className="text-6xl">🎛️</div>
          <h1 className="font-display text-3xl font-bold text-white">No Host Session</h1>
          <p className="text-sm text-indigo-200/70">
            Create a new FUZZAL arena lobby to access the control room.
          </p>
          <button className="btn-primary w-full py-3 mt-2" onClick={() => router.push("/")}>
            Create an Arena
          </button>
        </div>
      </GameShell>
    );
  }

  if (connState === "error" && !state) {
    return (
      <GameShell maxWidth="max-w-md">
        <div className="glass w-full p-8 text-center flex flex-col items-center gap-4">
          <div className="text-6xl">⚠️</div>
          <h1 className="font-display text-2xl font-bold text-white">Arena Connection Failed</h1>
          <p className="text-sm text-indigo-200/70">
            Unable to connect to game lobby <strong className="text-cyan-300">{code}</strong>.
          </p>
          <div className="flex flex-col gap-2.5 w-full mt-2">
            <button className="btn-primary w-full py-3" onClick={() => window.location.reload()}>
              Retry Connection
            </button>
            <button className="btn-secondary w-full py-2.5" onClick={() => router.push("/")}>
              Return to Setup
            </button>
          </div>
        </div>
      </GameShell>
    );
  }

  if (connState === "session_invalid" && token && !state) {
    return (
      <GameShell maxWidth="max-w-md">
        <div className="glass w-full p-8 text-center flex flex-col items-center gap-4">
          <div className="text-6xl">🔒</div>
          <h1 className="font-display text-2xl font-bold text-white">Host Session Ended</h1>
          <p className="text-sm text-indigo-200/70">
            This host token is no longer active. Create a new arena lobby to continue.
          </p>
          <button className="btn-primary w-full py-3 mt-2" onClick={() => router.push("/")}>
            Return to Setup
          </button>
        </div>
      </GameShell>
    );
  }

  if (!token || !state) {
    return (
      <GameShell maxWidth="max-w-sm">
        <div className="flex flex-col items-center gap-4 py-8">
          <div className="animate-float">
            <Logo size={64} />
          </div>
          <div className="flex items-center gap-3">
            <span className="h-3 w-3 animate-ping rounded-full bg-cyan-400 inline-block" />
            <p className="text-sm font-bold uppercase tracking-widest text-cyan-300">
              Opening Arena Lobby…
            </p>
          </div>
        </div>
      </GameShell>
    );
  }

  const players = state.players;
  const canStart = players.length >= 1;
  const totalPieces = state.pieceCount ?? state.gridCols * state.gridRows;
  const timerVal =
    state.status === "MEMORY"
      ? memorySeconds * 1000
      : state.status === "PUZZLE"
        ? puzzleRemainingMs
        : null;

  return (
    <div className="flex min-h-screen flex-col bg-[#050816] text-white selection:bg-cyan-500 selection:text-black">
      {/* Cockpit Top Bar */}
      <ControlRoomTopBar
        lobbyCode={code}
        status={state.status}
        playersCount={players.length}
        maxPlayers={state.maxPlayers}
        puzzleName={state.image?.name}
        gridCols={state.gridCols}
        gridRows={state.gridRows}
        pieceCount={totalPieces}
        timerMs={timerVal}
        onOpenDisplay={handleOpenDisplay}
        onNewArena={newLobby}
      />

      <ConnBanner state={connState} />

      {toast && (
        <div className="fixed left-1/2 top-16 z-50 -translate-x-1/2 rounded-full bg-rose-500/95 px-6 py-2.5 text-sm font-bold text-white shadow-[0_0_20px_rgba(244,63,94,0.6)]">
          {toast}
        </div>
      )}

      {/* Cockpit Workspace */}
      <main className="mx-auto flex-1 w-full max-w-7xl px-3 py-4 sm:px-6 sm:py-6">
        <div className="flex flex-col lg:flex-row gap-6 items-start">
          {/* Navigation Sidebar / Mobile Bar */}
          <ControlRoomNav
            activeTab={activeTab}
            onTabChange={setActiveTab}
            isLive={state.status === "LOBBY" || state.status === "MEMORY" || state.status === "PUZZLE"}
            playersCount={players.length}
          />

          {/* Active Workspace View */}
          <div className="flex-1 w-full min-w-0">
            {activeTab === "live" && (
              <LiveGameTab
                lobbyCode={code}
                status={state.status}
                players={players}
                progress={state.puzzleProgress}
                gridCols={state.gridCols}
                gridRows={state.gridRows}
                pieceCount={totalPieces}
                puzzleName={state.image?.name}
                timerMs={timerVal}
                canStart={canStart}
                image={state.image}
                memorySeconds={memorySeconds}
                result={state.result}
                maxPlayers={state.maxPlayers}
                onStartGame={actions.startGame}
                onPlayAgain={actions.playAgain}
                onBackToLobby={actions.backToLobby}
                onNewLobby={newLobby}
                onOpenDisplay={handleOpenDisplay}
              />
            )}

            {activeTab === "overview" && (
              <OverviewTab />
            )}

            {activeTab === "players" && (
              <PlayersTab />
            )}

            {activeTab === "history" && (
              <HistoryTab />
            )}

            {activeTab === "puzzles" && (
              <PuzzleLibraryTab />
            )}

            {activeTab === "config" && (
              <ConfigTab
                maxPlayers={configMaxPlayers}
                onMaxPlayersChange={setConfigMaxPlayers}
                gridSize={configGridSize}
                onGridSizeChange={setConfigGridSize}
                memorySeconds={configMemorySeconds}
                onMemorySecondsChange={setConfigMemorySeconds}
                puzzleSeconds={configPuzzleSeconds}
                onPuzzleSecondsChange={setConfigPuzzleSeconds}
                onSave={handleSaveConfig}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function HostPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#050816]">
          <span className="h-3 w-3 animate-ping rounded-full bg-cyan-400" />
        </div>
      }
    >
      <HostPageContent />
    </Suspense>
  );
}

