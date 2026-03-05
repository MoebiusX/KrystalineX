import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trash2, Clock, Activity, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { formatTimeAgo, truncateId } from "@/lib/utils";
import { getJaegerTraceUrl } from "@/lib/trace-utils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useState } from "react";

interface TraceData {
  traceId: string;
  rootSpanId: string;
  status: string;
  duration: number;
  startTime: string;
  spans: SpanData[];
}

interface SpanData {
  spanId: string;
  parentSpanId: string | null;
  traceId: string;
  operationName: string;
  serviceName: string;
  duration: number;
  startTime: string;
  endTime: string;
  tags: Record<string, any>;
}

function TraceItem({ trace, onTraceViewed }: { trace: TraceData; onTraceViewed?: () => void }) {
  const [expanded, setExpanded] = useState(false);

  // Get operation info from spans
  const orderSpan = trace.spans.find(s => s.operationName?.includes('order')) || trace.spans[0];
  const operation = orderSpan?.operationName || 'Trade';

  const handleExpand = () => {
    setExpanded(!expanded);
    // Mark trace as viewed when user expands it
    if (!expanded && onTraceViewed) {
      onTraceViewed();
    }
  };

  const handleExternalLink = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Mark trace as viewed when user opens in Jaeger
    if (onTraceViewed) {
      onTraceViewed();
    }
  };

  return (
    <div className="border border-slate-700 rounded-lg bg-slate-800 hover:bg-slate-750 transition-colors">
      <div
        className="p-4 cursor-pointer flex items-center justify-between"
        onClick={handleExpand}
      >
        <div className="flex items-center space-x-3">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-slate-400" />
          )}
          <Activity className="w-4 h-4 text-orange-400" />
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-medium text-white text-sm">
                {operation}
              </span>
              <Badge className="bg-green-500/20 text-green-400 border-none text-xs">
                OK
              </Badge>
            </div>
            <div className="text-sm text-slate-400">
              {truncateId(trace.traceId)} • {trace.duration?.toFixed(1)}ms • {formatTimeAgo(new Date(trace.startTime))}
            </div>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Badge className="bg-purple-500/20 text-purple-400 border-none text-xs">
            {trace.spans.length} spans
          </Badge>
          <a
            href={getJaegerTraceUrl(trace.traceId)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-slate-400 hover:text-white"
            onClick={handleExternalLink}
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-slate-700 bg-slate-850 p-4">
          <div className="mb-3">
            <h4 className="text-sm font-medium text-slate-400 uppercase tracking-wider">Trace Flow</h4>
          </div>
          <div className="space-y-2">
            {trace.spans.map((span) => (
              <div key={span.spanId} className="flex items-center justify-between text-sm py-1.5 px-2 bg-slate-900 rounded">
                <div className="flex items-center space-x-3">
                  <div className="w-2 h-2 rounded-full bg-orange-500"></div>
                  <span className="font-medium text-slate-300">{span.operationName}</span>
                  <span className="text-sm text-slate-500">({span.serviceName})</span>
                </div>
                <div className="flex items-center space-x-3">
                  <span className="text-sm text-slate-400 font-mono">
                    {span.duration ? `${span.duration.toFixed(2)}ms` : '0ms'}
                  </span>
                  <div className="px-2 py-0.5 bg-green-500/20 text-green-400 rounded text-xs">
                    ✓
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function TraceViewer() {
  // Get current user ID for filtering
  const getCurrentUserId = (): string | null => {
    try {
      const userData = localStorage.getItem('user');
      if (userData) {
        const parsed = JSON.parse(userData);
        return parsed.id || null;
      }
    } catch { }
    return null;
  };
  const currentUserId = getCurrentUserId();

  const { data: traces, isLoading } = useQuery<TraceData[]>({
    queryKey: ['/api/v1/traces', { userId: currentUserId }],
    queryFn: async () => {
      const kongUrl = import.meta.env.VITE_KONG_URL || '';
      const url = currentUserId
        ? `${kongUrl}/api/v1/traces?userId=${currentUserId}`
        : `${kongUrl}/api/v1/traces`;
      const res = await fetch(url);
      return res.json();
    },
    refetchInterval: 3000
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest('DELETE', '/api/v1/clear');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/v1/traces'] });
      queryClient.invalidateQueries({ queryKey: ['/api/v1/orders'] });
      queryClient.invalidateQueries({ queryKey: ['/api/v1/wallet'] });
    }
  });

  // Filter to show only trade-related operations (hide login, health checks, etc.)
  const TRADE_OPERATIONS = ['order', 'trade', 'transfer', 'payment', 'execute', 'match', 'settle', 'wallet', 'balance'];
  const EXCLUDED_OPERATIONS = ['auth', 'login', 'logout', 'register', 'health', 'status', 'clear', 'verify', 'refresh'];

  const isTradeRelated = (trace: TraceData): boolean => {
    // Check if any span in the trace is trade-related
    const hasTradeSpan = trace.spans.some(span => {
      const opName = (span.operationName || '').toLowerCase();
      const serviceName = (span.serviceName || '').toLowerCase();

      // Exclude if it matches excluded operations
      if (EXCLUDED_OPERATIONS.some(excluded => opName.includes(excluded))) {
        return false;
      }

      // Include if it matches trade operations
      return TRADE_OPERATIONS.some(trade => opName.includes(trade) || serviceName.includes(trade));
    });

    return hasTradeSpan;
  };

  const traceList = (traces || []).filter(isTradeRelated);

  // Callback to mark trace as viewed in localStorage
  const handleTraceViewed = () => {
    if (localStorage.getItem('hasViewedTrace') !== 'true') {
      localStorage.setItem('hasViewedTrace', 'true');
      // Dispatch a custom event so dashboard can update
      window.dispatchEvent(new CustomEvent('traceViewed'));
    }
  };

  if (isLoading) {
    return (
      <Card className="bg-slate-900 border-slate-700">
        <CardHeader>
          <CardTitle className="text-white">Traces</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-slate-800 rounded animate-pulse"></div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-slate-900 border-slate-700 border-2 border-purple-500/30">
      <CardHeader className="bg-slate-800/60">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center space-x-2 text-white">
              <div className="relative">
                <Clock className="w-5 h-5 text-purple-400" />
                {traceList.length > 0 && (
                  <div className="absolute -top-1 -right-1 w-2 h-2 bg-purple-400 rounded-full animate-pulse" />
                )}
              </div>
              <span>Live Traces</span>
              <Badge className="bg-purple-500/20 text-purple-300 border-purple-500/30">
                {traceList.length}
              </Badge>
            </CardTitle>
            <p className="text-xs text-purple-300/60 mt-1">OpenTelemetry • Real-time verification</p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={`${import.meta.env.VITE_GRAFANA_URL || 'http://localhost:3000'}/d/krystalinex-unified`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-3 py-1.5 bg-orange-600/20 hover:bg-orange-600/30 border border-orange-500/30 rounded-lg text-sm text-orange-300 transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Dashboard
            </a>
            <a
              href={`${import.meta.env.VITE_JAEGER_URL || 'http://localhost:16686'}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-3 py-1.5 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 rounded-lg text-sm text-indigo-300 transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Jaeger UI
            </a>
            <Button
              variant="outline"
              size="sm"
              onClick={() => clearMutation.mutate()}
              disabled={clearMutation.isPending}
              className="text-red-400 border-slate-600 hover:bg-red-500/10 hover:border-red-500/50"
            >
              <Trash2 className="w-4 h-4 mr-1" />
              Clear
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {traceList.length > 0 ? (
          <div className="space-y-3">
            {traceList.map((trace) => (
              <TraceItem key={trace.traceId} trace={trace} onTraceViewed={handleTraceViewed} />
            ))}

            {/* Jaeger CTA */}
            <div className="mt-4 p-4 bg-slate-800/60 rounded-lg border border-indigo-500/20">
              <p className="text-sm text-indigo-200/80 mb-2">Want the full picture?</p>
              <a
                href={`${import.meta.env.VITE_JAEGER_URL || 'http://localhost:16686'}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                Open Jaeger Dashboard
              </a>
            </div>
          </div>
        ) : (
          <div className="text-center py-12 text-slate-500">
            <div className="relative inline-block">
              <Clock className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <div className="absolute inset-0 animate-ping">
                <Clock className="w-12 h-12 mx-auto opacity-10" />
              </div>
            </div>
            <p className="font-medium text-slate-400">Waiting for traces...</p>
            <p className="text-sm mt-1">Make a trade and watch it appear here in real-time</p>
            <div className="mt-4 flex items-center justify-center gap-2 text-xs text-purple-400/60">
              <Activity className="w-3 h-3" />
              <span>Powered by OpenTelemetry</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
