/**
 * Trade Trace Timeline - Visual distributed trace viewer for transparency
 * Shows how a single trade flows through the entire system
 * 
 * IMPORTANT: This component ONLY displays real trace data from the API.
 * No mock/fake data is ever shown. Empty state is preferred over fake data.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { createLogger } from "@/lib/logger";

const log = createLogger('TraceTimeline');
import { Button } from "@/components/ui/button";
import {
  Activity,
  CheckCircle2,
  Clock,
  ExternalLink,
  Shield,
  Zap,
  Database,
  Server,
  AlertCircle
} from "lucide-react";
import { getJaegerTraceUrl } from "@/lib/trace-utils";
import { useState, useEffect } from "react";

interface TraceSpan {
  spanId: string;
  operation: string;
  service: string;
  duration: number;
  status: string;
  startOffset: number; // ms from trace start
}

interface TradeTrace {
  traceId: string;
  orderId?: string;
  timestamp: string;
  duration: number;
  status: string;
  spans: TraceSpan[];
}

interface TradeTraceTimelineProps {
  traceId?: string;
  className?: string;
}

const SERVICE_ICONS: Record<string, any> = {
  'api-gateway': Server,
  'kong': Shield,
  'kx-exchange': Activity,
  'exchange-api': Activity,  // Legacy fallback
  'kx-matcher': Zap,
  'order-matcher': Zap,  // Legacy fallback
  'kx-wallet': Database,
  'wallet-service': Database,  // Legacy fallback
  default: Activity,
};

const SERVICE_COLORS: Record<string, string> = {
  'api-gateway': 'bg-blue-500',
  'kong': 'bg-purple-500',
  'kx-exchange': 'bg-emerald-500',
  'exchange-api': 'bg-emerald-500',  // Legacy fallback
  'kx-matcher': 'bg-orange-500',
  'order-matcher': 'bg-orange-500',  // Legacy fallback
  'kx-wallet': 'bg-cyan-500',
  'wallet-service': 'bg-cyan-500',  // Legacy fallback
  default: 'bg-slate-500',
};

export function TradeTraceTimeline({ traceId, className }: TradeTraceTimelineProps) {
  const [selectedSpan, setSelectedSpan] = useState<TraceSpan | null>(null);
  const [trace, setTrace] = useState<TradeTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!traceId) {
      return; // No trace ID provided - show nothing
    }

    const fetchTrace = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/public/trace/${traceId}`);

        if (!response.ok) {
          throw new Error(`Failed to fetch trace: ${response.statusText}`);
        }

        const data = await response.json();
        setTrace(data);
      } catch (err: any) {
        log.error({ err }, 'Error fetching trace');
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchTrace();
  }, [traceId]);

  // No trace ID provided - don't show anything
  if (!traceId) {
    return null;
  }

  // Loading state
  if (loading) {
    return (
      <Card className="bg-gradient-to-br from-slate-900/90 to-slate-800/90 border-cyan-500/20 backdrop-blur-xl">
        <CardContent className="p-8">
          <div className="flex items-center justify-center gap-3 text-cyan-100/60">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-cyan-400 border-t-transparent" />
            <span>Loading trace data...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Error state - show real error
  if (error) {
    return (
      <Card className="bg-gradient-to-br from-slate-900/90 to-slate-800/90 border-red-500/20 backdrop-blur-xl">
        <CardContent className="p-8">
          <div className="flex items-center gap-4 text-red-100/90">
            <div className="flex-shrink-0">
              <AlertCircle className="h-6 w-6 text-red-400" />
            </div>
            <div className="flex-1">
              <p className="font-semibold text-base text-red-100">Trace Data Unavailable</p>
              <p className="text-sm text-red-100/70 mt-1.5 leading-relaxed">{error}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // No trace data available
  if (!trace || !trace.spans || trace.spans.length === 0) {
    return (
      <Card className="bg-gradient-to-br from-slate-900/90 to-slate-800/90 border-slate-700/50 backdrop-blur-xl">
        <CardContent className="p-8">
          <div className="text-center text-cyan-100/60">
            <Activity className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No trace data available for this trade</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ONLY show real data below this point
  const maxDuration = Math.max(...trace.spans.map(s => s.startOffset + s.duration));

  const getServiceIcon = (service: string) => {
    const Icon = SERVICE_ICONS[service] || SERVICE_ICONS.default;
    return <Icon className="w-4 h-4" />;
  };

  const getServiceColor = (service: string) => {
    return SERVICE_COLORS[service] || SERVICE_COLORS.default;
  };

  return (
    <div className={className}>
      <Card className="bg-gradient-to-br from-slate-900/90 to-slate-800/90 border-cyan-500/20 backdrop-blur-xl">
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <CardTitle className="text-lg sm:text-xl flex items-center gap-2 text-cyan-100">
                <Activity className="w-4 h-4 sm:w-5 sm:h-5 text-cyan-400" />
                Trade Trace Timeline
              </CardTitle>
              <p className="text-xs sm:text-sm text-cyan-100/60 mt-1">
                End-to-end distributed trace visualization (Real data from OpenTelemetry)
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <div className="text-xs sm:text-sm text-cyan-100/60">Total Duration</div>
                <div className="text-xl sm:text-2xl font-semibold text-emerald-400">
                  {trace.duration}ms
                </div>
              </div>
              <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
                <CheckCircle2 className="w-3 h-3 mr-1" />
                {trace.status}
              </Badge>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* Trace Info */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 text-sm">
            <div className="flex items-center gap-2 text-xs sm:text-sm">
              <span className="text-cyan-100/60">Trace ID:</span>
              <code className="text-cyan-100 bg-slate-800/50 px-2 py-0.5 rounded font-mono text-xs border border-cyan-500/20">
                {trace.traceId}
              </code>
            </div>
            {trace.orderId && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-cyan-100/60">Order ID:</span>
                <code className="text-cyan-100 bg-slate-800/50 px-2 py-0.5 rounded font-mono text-xs border border-cyan-500/20">
                  {trace.orderId}
                </code>
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10"
              onClick={() => window.open(getJaegerTraceUrl(trace.traceId), '_blank')}
            >
              <ExternalLink className="w-4 h-4 mr-1" />
              View in Jaeger
            </Button>
          </div>

          {/* Timeline Visualization */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-4">
              <Clock className="w-4 h-4 text-cyan-400" />
              <span className="text-xs sm:text-sm text-cyan-100/80">Service Execution Flow ({trace.spans.length} spans, {trace.duration}ms total)</span>
            </div>

            {trace.spans.map((span, index) => {
              const widthPercent = (span.duration / maxDuration) * 100;
              const offsetPercent = (span.startOffset / maxDuration) * 100;
              const isSelected = selectedSpan?.spanId === span.spanId;

              return (
                <div key={span.spanId} className="space-y-1">
                  {/* Span Label */}
                  <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 text-xs sm:text-sm">
                    <div className={`flex items-center gap-1.5 sm:gap-2 ${getServiceColor(span.service)} text-white px-2 py-1 rounded shadow-lg text-xs sm:text-sm`}>
                      {getServiceIcon(span.service)}
                      <span className="font-medium whitespace-nowrap">{span.service}</span>
                    </div>
                    <span className="text-cyan-100/80 truncate flex-1">{span.operation}</span>
                    <span className="text-amber-400 font-mono text-xs font-medium whitespace-nowrap">
                      {span.duration}ms
                    </span>
                  </div>

                  {/* Timeline Bar */}
                  <div className="relative h-8 bg-slate-800/50 rounded overflow-hidden border border-slate-700/50">
                    {/* Duration Bar */}
                    <div
                      className={`absolute h-full ${getServiceColor(span.service)} transition-all cursor-pointer hover:brightness-110 hover:shadow-lg`}
                      style={{
                        left: `${offsetPercent}%`,
                        width: `${widthPercent}%`,
                      }}
                      onClick={() => setSelectedSpan(isSelected ? null : span)}
                    >
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-xs text-white font-semibold drop-shadow">
                          {span.duration}ms
                        </span>
                      </div>
                    </div>

                    {/* Time markers */}
                    {index === 0 && (
                      <div className="absolute inset-0 flex justify-between items-end px-1 pb-0.5 text-[10px] text-slate-600 pointer-events-none font-mono">
                        <span>0ms</span>
                        <span>{Math.round(maxDuration / 2)}ms</span>
                        <span>{maxDuration}ms</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selected Span Details */}
          {selectedSpan && (
            <Card className="bg-slate-800/50 border-cyan-500/30 backdrop-blur">
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className={`flex items-center gap-2 ${getServiceColor(selectedSpan.service)} text-white px-2 py-1 rounded shadow-lg`}>
                      {getServiceIcon(selectedSpan.service)}
                      <span className="font-medium">{selectedSpan.service}</span>
                    </div>
                  </div>
                  <Badge variant="outline" className="text-emerald-400 border-emerald-500/30 bg-emerald-500/10">
                    {selectedSpan.status}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-cyan-100/60">Operation</span>
                    <div className="text-cyan-100 font-mono text-xs mt-1">
                      {selectedSpan.operation}
                    </div>
                  </div>
                  <div>
                    <span className="text-cyan-100/60">Duration</span>
                    <div className="text-amber-400 font-semibold mt-1">
                      {selectedSpan.duration}ms
                    </div>
                  </div>
                  <div>
                    <span className="text-cyan-100/60">Start Offset</span>
                    <div className="text-cyan-100 mt-1">
                      +{selectedSpan.startOffset}ms
                    </div>
                  </div>
                  <div>
                    <span className="text-cyan-100/60">Span ID</span>
                    <div className="text-cyan-100 font-mono text-xs mt-1 truncate">
                      {selectedSpan.spanId}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Trust Indicators */}
          <div className="flex items-center justify-between pt-4 border-t border-slate-700/50">
            <div className="flex items-center gap-4 text-sm">
              <div className="flex items-center gap-2 text-emerald-400">
                <CheckCircle2 className="w-4 h-4" />
                <span>Live Trace Data</span>
              </div>
              <div className="flex items-center gap-2 text-cyan-400">
                <Activity className="w-4 h-4" />
                <span>{trace.spans.length} Spans Recorded</span>
              </div>
              <div className="flex items-center gap-2 text-amber-400">
                <Clock className="w-4 h-4" />
                <span>{trace.duration}ms Total</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
