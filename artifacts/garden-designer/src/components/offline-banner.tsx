import React, { useEffect, useState } from 'react';
import { useOnlineStatus } from '../hooks/use-online-status';
import { getPendingSyncCount } from '../services/offline-storage';
import { runSync } from '../services/offline-sync';
import { WifiOff, Wifi, RefreshCw, CheckCircle } from 'lucide-react';

export function OfflineBanner() {
  const { isOnline, wasOffline } = useOnlineStatus();
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncDone, setSyncDone] = useState(false);

  useEffect(() => {
    getPendingSyncCount().then(setPendingCount).catch(() => {});
  }, [isOnline]);

  useEffect(() => {
    if (isOnline && wasOffline && pendingCount > 0) {
      handleSync();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, wasOffline]);

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await runSync();
      if (result.synced > 0) {
        setSyncDone(true);
        setPendingCount(0);
        setTimeout(() => setSyncDone(false), 3000);
      }
    } finally {
      setSyncing(false);
    }
  };

  if (isOnline && !wasOffline && pendingCount === 0) return null;

  return (
    <div
      className={`fixed top-0 left-0 right-0 z-[9999] flex items-center justify-between px-4 py-2 text-sm font-medium transition-all duration-300 ${
        isOnline
          ? syncDone
            ? 'bg-green-600 text-white'
            : 'bg-blue-600 text-white'
          : 'bg-amber-500 text-white'
      }`}
    >
      <div className="flex items-center gap-2">
        {isOnline ? (
          syncDone ? (
            <CheckCircle size={16} />
          ) : (
            <Wifi size={16} />
          )
        ) : (
          <WifiOff size={16} className="animate-pulse" />
        )}
        <span>
          {syncDone
            ? `Sincronización completada (${pendingCount} proyecto${pendingCount !== 1 ? 's' : ''})`
            : isOnline && pendingCount > 0
            ? `Reconectado — ${pendingCount} proyecto${pendingCount !== 1 ? 's' : ''} pendiente${pendingCount !== 1 ? 's' : ''} de sincronizar`
            : wasOffline
            ? 'Conexión restaurada'
            : 'Sin conexión — Modo offline activado. Los cambios se guardan localmente.'}
        </span>
      </div>

      {isOnline && pendingCount > 0 && !syncDone && (
        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-1 bg-white/20 hover:bg-white/30 rounded px-2 py-1 text-xs"
        >
          <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Sincronizando...' : 'Sincronizar'}
        </button>
      )}
    </div>
  );
}
