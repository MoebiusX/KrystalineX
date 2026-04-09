import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useState, useEffect, useRef } from "react";
import { createLogger } from "@/lib/logger";

const log = createLogger('Monitor');
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import Layout from "@/components/Layout";
import { getJaegerTraceUrl } from "@/lib/trace-utils";
import { BaselineStatusBadge, type BaselineStatusIndicator } from "@/components/ui/baseline-status-badge";
import { DeviationMiniChart } from "@/components/ui/deviation-mini-chart";

// Severity configuration (SEV 1-5)
const SEVERITY_CONFIG = {
    1: { name: 'Critical', color: 'bg-red-600', textColor: 'text-red-400', badge: 'SEV1' },
    2: { name: 'Major', color: 'bg-orange-600', textColor: 'text-orange-400', badge: 'SEV2' },
    3: { name: 'Moderate', color: 'bg-amber-600', textColor: 'text-amber-400', badge: 'SEV3' },
    4: { name: 'Minor', color: 'bg-yellow-600', textColor: 'text-yellow-400', badge: 'SEV4' },
    5: { name: 'Low', color: 'bg-lime-600', textColor: 'text-lime-400', badge: 'SEV5' },
} as const;

type SeverityLevel = 1 | 2 | 3 | 4 | 5;

// WebSocket message types
interface WSMessage {
    type: 'analysis-start' | 'analysis-chunk' | 'analysis-complete' | 'alert' | 'heartbeat';
    data?: any;
    anomalyIds?: string[];
    timestamp?: string;
}

interface LiveAlert {
    severity: 'critical' | 'high' | 'medium';
    message: string;
    timestamp: string;
}

// Types
interface ServiceHealth {
    name: string;
    status: 'healthy' | 'warning' | 'critical' | 'unknown';
    avgDuration: number;
    spanCount: number;
    activeAnomalies: number;
    lastSeen: string;
}

interface SpanBaseline {
    service: string;
    operation: string;
    spanKey: string;
    mean: number;
    stdDev: number;
    p50: number;
    p95: number;
    p99: number;
    sampleCount: number;
    lastUpdated: string;
    statusIndicator?: BaselineStatusIndicator;
}

interface Anomaly {
    id: string;
    traceId: string;
    service: string;
    operation: string;
    duration: number;
    expectedMean: number;
    expectedStdDev: number;
    deviation: number;
    severity: SeverityLevel;
    severityName: string;
    timestamp: string;
    dayOfWeek?: number;
    hourOfDay?: number;
}

interface AnalysisResponse {
    traceId: string;
    summary: string;
    possibleCauses: string[];
    recommendations: string[];
    confidence: 'low' | 'medium' | 'high';
    prompt?: string;        // Exact prompt sent to LLM (for training)
    rawResponse?: string;   // Raw LLM response (for training)
}

interface RecalculateResponse {
    success: boolean;
    baselinesCount: number;
    duration: number;
    message: string;
}

interface CorrelatedMetrics {
    anomalyId: string;
    timestamp: string;
    service: string;
    metrics: {
        cpuPercent: number | null;
        memoryMB: number | null;
        requestRate: number | null;
        errorRate: number | null;
        p99LatencyMs: number | null;
        activeConnections: number | null;
    };
    insights: string[];
    healthy: boolean;
}

interface AmountAnomaly {
    id: string;
    orderId?: string;
    transferId?: string;
    traceId?: string;
    userId: string;
    operationType: string;
    asset: string;
    amount: number;
    dollarValue: number;
    expectedMean: number;
    expectedStdDev: number;
    deviation: number;
    severity: SeverityLevel;
    severityName: string;
    timestamp: string;
    reason: string;
}

export default function Monitor() {
    const [, navigate] = useLocation();
    const queryClient = useQueryClient();
    const [selectedAnomaly, setSelectedAnomaly] = useState<Anomaly | null>(null);
    const [minSeverity, setMinSeverity] = useState<SeverityLevel>(5); // Show all by default (SEV 5 = lowest)

    // Live streaming state
    const [streamingText, setStreamingText] = useState<string>('');
    const [isStreaming, setIsStreaming] = useState<boolean>(false);
    const [streamingAnomalyIds, setStreamingAnomalyIds] = useState<string[]>([]);
    const [liveAlerts, setLiveAlerts] = useState<LiveAlert[]>([]);
    const [wsConnected, setWsConnected] = useState<boolean>(false);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const wsRef = useRef<WebSocket | null>(null);

    // WebSocket connection
    useEffect(() => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/monitor`;

        const connect = () => {
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;

            ws.onopen = () => {
                log.info('Connected to monitor');
                setWsConnected(true);
            };

            ws.onclose = () => {
                log.warn('Disconnected, reconnecting...');
                setWsConnected(false);
                setTimeout(connect, 3000);
            };

            ws.onmessage = (event) => {
                const msg: WSMessage = JSON.parse(event.data);

                switch (msg.type) {
                    case 'analysis-start':
                        setIsStreaming(true);
                        setStreamingText('');
                        setStreamingAnomalyIds(msg.anomalyIds || []);
                        break;

                    case 'analysis-chunk':
                        setStreamingText(prev => prev + (msg.data || ''));
                        break;

                    case 'analysis-complete':
                        setIsStreaming(false);
                        setLastUpdated(new Date());
                        break;

                    case 'alert':
                        setLiveAlerts(prev => [{
                            severity: msg.data.severity,
                            message: msg.data.message,
                            timestamp: msg.timestamp || new Date().toISOString()
                        }, ...prev].slice(0, 5)); // Keep last 5 alerts
                        break;
                }
            };

            ws.onerror = (err) => {
                log.error({ err }, 'WebSocket error');
            };
        };

        connect();

        return () => {
            wsRef.current?.close();
        };
    }, []);

    // Fetch health data
    const { data: healthData } = useQuery<{ status: string; services: ServiceHealth[] }>({
        queryKey: ["/api/v1/monitor/health"],
        refetchInterval: 5000,
    });

    // Fetch baselines (with status indicators)
    const { data: baselinesData } = useQuery<{ baselines: SpanBaseline[] }>({
        queryKey: ["/api/v1/monitor/baselines/enriched"],
        refetchInterval: 10000,
    });

    // Fetch anomalies
    const { data: anomaliesData } = useQuery<{ active: Anomaly[] }>({
        queryKey: ["/api/v1/monitor/anomalies"],
        refetchInterval: 5000,
    });

    // Fetch amount anomalies (whale detection)
    const { data: amountAnomaliesData } = useQuery<{ active: AmountAnomaly[]; enabled: boolean }>({
        queryKey: ["/api/v1/monitor/amount-anomalies"],
        refetchInterval: 5000,
    });

    // Analyze mutation
    const analyzeMutation = useMutation({
        mutationFn: async (traceId: string) => {
            const res = await fetch("/api/v1/monitor/analyze", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ traceId }),
            });
            return res.json() as Promise<AnalysisResponse>;
        },
    });

    // Metrics correlation mutation
    const correlationMutation = useMutation({
        mutationFn: async (anomaly: Anomaly) => {
            const res = await fetch("/api/v1/monitor/correlate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    anomalyId: anomaly.id,
                    service: anomaly.service,
                    timestamp: anomaly.timestamp,
                }),
            });
            return res.json() as Promise<CorrelatedMetrics>;
        },
    });

    // Recalculate baselines mutation
    const recalculateMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch("/api/v1/monitor/recalculate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            });
            return res.json() as Promise<RecalculateResponse>;
        },
        onSuccess: () => {
            // Refresh all data after recalculation
            queryClient.invalidateQueries({ queryKey: ["/api/v1/monitor"] });
        },
    });

    // Training data rating mutation
    const [showCorrectionModal, setShowCorrectionModal] = useState(false);
    const [correctionText, setCorrectionText] = useState('');
    const [ratingSuccess, setRatingSuccess] = useState<'good' | 'bad' | null>(null);

    const ratingMutation = useMutation({
        mutationFn: async ({ rating, correction }: { rating: 'good' | 'bad'; correction?: string }) => {
            if (!selectedAnomaly || !analyzeMutation.data || (analyzeMutation.data as any).status === 'processing') return;

            // Use the EXACT prompt and response from the LLM call
            const res = await fetch("/api/v1/monitor/training/rate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    anomaly: {
                        id: selectedAnomaly.id,
                        traceId: selectedAnomaly.traceId,
                        service: selectedAnomaly.service,
                        operation: selectedAnomaly.operation,
                        duration: selectedAnomaly.duration,
                        expectedMean: selectedAnomaly.expectedMean,
                        deviation: selectedAnomaly.deviation,
                        severity: selectedAnomaly.severity,
                        severityName: selectedAnomaly.severityName,
                        timestamp: selectedAnomaly.timestamp,
                    },
                    // Use exact prompt and response from the analysis (for training)
                    prompt: analyzeMutation.data.prompt || `Analyze anomaly: ${selectedAnomaly.service}:${selectedAnomaly.operation}`,
                    completion: analyzeMutation.data.rawResponse || `${analyzeMutation.data.summary}\n\nCauses: ${(analyzeMutation.data.possibleCauses || []).join(', ')}\n\nRecommendations: ${(analyzeMutation.data.recommendations || []).join(', ')}`,
                    rating,
                    correction,
                }),
            });
            return res.json();
        },
        onSuccess: (_, variables) => {
            setRatingSuccess(variables.rating);
            setShowCorrectionModal(false);
            setCorrectionText('');
            setTimeout(() => setRatingSuccess(null), 3000);
        },
    });

    // Training stats query
    const { data: trainingStats } = useQuery<{ totalExamples: number; goodExamples: number; badExamples: number }>({
        queryKey: ["/api/v1/monitor/training/stats"],
        refetchInterval: 30000,
    });

    // Handler to select anomaly and reset previous analysis
    const handleSelectAnomaly = (anomaly: Anomaly) => {
        setSelectedAnomaly(anomaly);
        analyzeMutation.reset();
        correlationMutation.reset();
        // Auto-fetch correlated metrics
        correlationMutation.mutate(anomaly);
    };

    // Handler to clear selection
    const handleClearSelection = () => {
        setSelectedAnomaly(null);
        analyzeMutation.reset();
        correlationMutation.reset();
    };

    // Get severity badge styling
    const getSeverityBadge = (severity: SeverityLevel) => {
        const config = SEVERITY_CONFIG[severity];
        return {
            className: `${config.color} text-white font-bold`,
            label: config.badge,
            name: config.name,
        };
    };

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'healthy': return 'bg-emerald-500';
            case 'warning': return 'bg-amber-500';
            case 'critical': return 'bg-red-500';
            default: return 'bg-slate-500';
        }
    };

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'healthy': return { label: 'HEALTHY', className: 'bg-emerald-600/20 text-emerald-400 border-emerald-500/30' };
            case 'warning': return { label: 'WARNING', className: 'bg-amber-600/20 text-amber-400 border-amber-500/30' };
            case 'critical': return { label: 'CRITICAL', className: 'bg-red-600/20 text-red-400 border-red-500/30' };
            default: return { label: 'UNKNOWN', className: 'bg-slate-600/20 text-slate-400 border-slate-500/30' };
        }
    };

    const formatDuration = (ms: number) => {
        if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
        if (ms < 1000) return `${ms.toFixed(1)}ms`;
        return `${(ms / 1000).toFixed(2)}s`;
    };


    const formatTime = (timestamp: string) => {
        const date = new Date(timestamp);
        return date.toLocaleTimeString();
    };

    return (
        <Layout>
            <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-900 text-cyan-100 p-6 sm:p-8">
                {/* Header */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
                    <div className="flex items-center gap-4">
                        <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-400 via-blue-400 to-indigo-400 bg-clip-text text-transparent">Trace Monitor</h1>
                        <Badge
                            className={`${getStatusColor(healthData?.status || 'unknown')} text-white text-sm sm:text-base px-3 py-1 shadow-lg`}
                        >
                            {healthData?.status?.toUpperCase() || 'LOADING'}
                        </Badge>
                    </div>
                    <div className="flex flex-wrap gap-2 sm:gap-3">
                        <button
                            onClick={() => {
                                queryClient.invalidateQueries({ queryKey: ["/api/v1/monitor"] });
                            }}
                            className="px-4 py-2 rounded-lg border border-cyan-500/30 bg-slate-800/50 text-cyan-100 hover:bg-slate-800 hover:border-cyan-400/50 text-sm sm:text-base font-medium transition-all duration-300 backdrop-blur"
                        >
                            ↻ Refresh
                        </button>
                        <button
                            onClick={() => recalculateMutation.mutate()}
                            disabled={recalculateMutation.isPending}
                            className="px-4 py-2 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:from-purple-500 hover:to-indigo-500 text-sm sm:text-base font-medium transition-all duration-300 disabled:opacity-50 shadow-lg shadow-purple-500/25"
                        >
                            {recalculateMutation.isPending ? 'Calculating...' : 'Recalculate Baselines'}
                        </button>
                        <button
                            onClick={() => window.open(import.meta.env.VITE_JAEGER_URL || "http://localhost:16686", "_blank")}
                            className="px-4 py-2 rounded-lg border border-cyan-500/30 bg-slate-800/50 text-cyan-100 hover:bg-slate-800 hover:border-cyan-400/50 text-sm sm:text-base font-medium transition-all duration-300 backdrop-blur"
                        >
                            View in Jaeger
                        </button>
                    </div>
                </div>

                {/* Recalculation Status */}
                {recalculateMutation.data && (
                    <div className={`mb-4 p-3 rounded-lg ${recalculateMutation.data.success ? 'bg-emerald-900/50 border border-emerald-700' : 'bg-red-900/50 border border-red-700'}`}>
                        <span className="text-base">
                            {recalculateMutation.data.success ? '✅' : '❌'} {recalculateMutation.data.message}
                            {recalculateMutation.data.success && ` (${recalculateMutation.data.duration}ms)`}
                        </span>
                    </div>
                )}

                {/* Live Analysis Panel */}
                <Card className="mb-6 bg-slate-800/50 backdrop-blur border-cyan-500/30 shadow-xl">
                    <CardHeader className="pb-3">
                        <div className="flex items-center justify-between">
                            <CardTitle className="text-cyan-100 text-xl font-semibold flex items-center gap-3">
                                <span className={`h-3 w-3 rounded-full ${wsConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}></span>
                                Live Analysis
                                {isStreaming && <span className="text-sm text-cyan-400/70 font-normal">(streaming...)</span>}
                            </CardTitle>
                            <div className="flex items-center gap-3">
                                {lastUpdated && (
                                    <span className="text-sm text-cyan-400/70">
                                        Last updated: {lastUpdated.toLocaleTimeString()}
                                    </span>
                                )}
                                <Badge className={`${wsConnected ? 'bg-emerald-900/50 text-emerald-400 border-emerald-500/30' : 'bg-red-900/50 text-red-400 border-red-500/30'}`}>
                                    {wsConnected ? 'Connected' : 'Disconnected'}
                                </Badge>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        {/* Live Alerts */}
                        {liveAlerts.length > 0 && (
                            <div className="mb-4 space-y-2">
                                {liveAlerts.map((alert, i) => (
                                    <div
                                        key={i}
                                        className={`p-3 rounded-lg border ${alert.severity === 'critical'
                                            ? 'bg-red-900/30 border-red-700'
                                            : alert.severity === 'high'
                                                ? 'bg-orange-900/30 border-orange-700'
                                                : 'bg-amber-900/30 border-amber-700'
                                            }`}
                                    >
                                        <span className="font-medium">
                                            <Badge className={`mr-2 ${alert.severity === 'critical' ? 'bg-red-600 text-white' :
                                                alert.severity === 'high' ? 'bg-orange-600 text-white' :
                                                    'bg-amber-600 text-white'
                                                }`}>
                                                {alert.severity === 'critical' ? 'CRITICAL' : alert.severity === 'high' ? 'HIGH' : 'MEDIUM'}
                                            </Badge>
                                            {alert.message}
                                        </span>
                                        <span className="text-xs text-slate-400 ml-2">
                                            {new Date(alert.timestamp).toLocaleTimeString()}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Streaming Output */}
                        {(streamingText || isStreaming) ? (
                            <div className="bg-slate-900/50 rounded-lg p-4 border border-cyan-500/20">
                                <div className="font-mono text-sm text-cyan-300/90 whitespace-pre-wrap min-h-[100px] max-h-[300px] overflow-y-auto leading-relaxed">
                                    {streamingText || 'Waiting for analysis...'}
                                    {isStreaming && <span className="animate-pulse text-cyan-400">|</span>}
                                </div>
                                {streamingAnomalyIds.length > 0 && (
                                    <div className="mt-2 text-xs text-slate-500">
                                        Analyzing anomalies: {streamingAnomalyIds.slice(0, 3).map(id => id.slice(0, 8)).join(', ')}
                                        {streamingAnomalyIds.length > 3 && ` +${streamingAnomalyIds.length - 3} more`}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="bg-slate-900/50 rounded-lg p-4 border border-cyan-500/20 text-cyan-400/70 text-center">
                                <p className="text-base font-medium">Monitoring for Critical Anomalies</p>
                                <p className="text-sm mt-1 text-cyan-400/50">Real-time analysis will begin when SEV1-3 alerts are detected</p>
                            </div>
                        )}
                    </CardContent>
                </Card>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Service Health Panel */}
                    <Card className="bg-slate-800/50 backdrop-blur border-cyan-500/30 shadow-xl">
                        <CardHeader className="pb-4">
                            <CardTitle className="text-cyan-100 text-xl font-semibold">Service Health</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-3">
                                {healthData?.services?.map((service) => (
                                    <div
                                        key={service.name}
                                        className="flex items-center justify-between p-4 rounded-lg bg-slate-900/50 border border-cyan-500/20 hover:border-cyan-400/30 transition-all duration-300"
                                    >
                                        <div className="flex items-center gap-3">
                                            <Badge className={`${getStatusBadge(service.status).className} border text-xs px-2 py-1`}>
                                                {getStatusBadge(service.status).label}
                                            </Badge>
                                            <span className="font-mono text-base text-white">{service.name}</span>
                                        </div>
                                        <div className="text-right">
                                            <div className="text-base text-slate-200 font-medium">
                                                {formatDuration(service.avgDuration)} avg
                                            </div>
                                            {service.activeAnomalies > 0 && (
                                                <div className="text-amber-400 text-sm font-medium">
                                                    {service.activeAnomalies} alert{service.activeAnomalies > 1 ? 's' : ''}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                                {(!healthData?.services || healthData.services.length === 0) && (
                                    <div className="text-slate-400 text-center py-6 text-base">
                                        Collecting baseline data...
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>

                    {/* Active Anomalies Panel */}
                    <Card className="bg-slate-800/50 backdrop-blur border-cyan-500/30 shadow-xl lg:col-span-2">
                        <CardHeader className="pb-4">
                            <div className="flex items-center justify-between">
                                <CardTitle className="text-cyan-100 text-xl font-semibold flex items-center gap-3">
                                    Active Alerts
                                    {anomaliesData?.active && anomaliesData.active.length > 0 && (
                                        <Badge variant="destructive" className="text-base px-3">{anomaliesData.active.length}</Badge>
                                    )}
                                </CardTitle>
                                <div className="flex items-center gap-2">
                                    <span className="text-cyan-400/70 text-sm">Min Level:</span>
                                    <select
                                        value={minSeverity}
                                        onChange={(e) => setMinSeverity(Number(e.target.value) as SeverityLevel)}
                                        className="bg-slate-900/50 border border-cyan-500/30 text-cyan-100 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/50 transition-all backdrop-blur"
                                    >
                                        <option value={5}>All (SEV5+)</option>
                                        <option value={4}>SEV4+ Minor</option>
                                        <option value={3}>SEV3+ Moderate</option>
                                        <option value={2}>SEV2+ Major</option>
                                        <option value={1}>SEV1 Critical Only</option>
                                    </select>
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-3 max-h-72 overflow-y-auto">
                                {anomaliesData?.active?.filter(a => a.severity <= minSeverity).map((anomaly) => {
                                    const sevBadge = getSeverityBadge(anomaly.severity);
                                    const borderColor = anomaly.severity <= 2
                                        ? 'border-red-600 bg-red-950/50 hover:bg-red-950/70'
                                        : anomaly.severity <= 3
                                            ? 'border-amber-600 bg-amber-950/50 hover:bg-amber-950/70'
                                            : 'border-yellow-600 bg-yellow-950/50 hover:bg-yellow-950/70';

                                    return (
                                        <div
                                            key={anomaly.id}
                                            className={`p-4 rounded-lg cursor-pointer transition-all border-2 ${selectedAnomaly?.id === anomaly.id ? 'ring-2 ring-purple-500' : ''
                                                } ${borderColor}`}
                                            onClick={() => handleSelectAnomaly(anomaly)}
                                        >
                                            <div className="flex justify-between items-start">
                                                <div>
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <Badge className={`${sevBadge.className} text-xs px-2 py-0.5`}>
                                                            {sevBadge.label}
                                                        </Badge>
                                                        <span className="text-slate-400 text-sm">{sevBadge.name}</span>
                                                    </div>
                                                    <div className="font-mono text-base text-white font-medium">
                                                        <span className="text-cyan-400">{anomaly.service}</span>
                                                        <span className="text-slate-400">:</span>
                                                        <span className="text-white">{anomaly.operation}</span>
                                                    </div>
                                                    <div className="text-base text-slate-200 mt-1">
                                                        <span className="text-red-400 font-semibold">{formatDuration(anomaly.duration)}</span>
                                                        {' '}({anomaly.deviation.toFixed(1)}σ from mean)
                                                    </div>
                                                </div>
                                                <div className="text-right">
                                                    <div className="text-slate-300 text-sm">{formatTime(anomaly.timestamp)}</div>
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        className="text-sm h-7 px-2 mt-1 text-cyan-400 hover:text-cyan-300"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            window.open(getJaegerTraceUrl(anomaly.traceId), "_blank");
                                                        }}
                                                    >
                                                        View Trace →
                                                    </Button>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                                {(!anomaliesData?.active || anomaliesData.active.filter(a => a.severity <= minSeverity).length === 0) && (
                                    <div className="text-slate-400 text-center py-10 text-lg">
                                        {anomaliesData?.active?.length ? `No anomalies at SEV${minSeverity} or higher` : '✅ No active anomalies'}
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                </div>

                {/* AI Analysis Panel - placed before Baseline Statistics for easier access */}
                <Card className="bg-slate-900 border-slate-700 mt-6">
                    <CardHeader className="pb-4">
                        <CardTitle className="text-white text-xl font-semibold flex items-center gap-3">
                            🤖 AI Analysis
                            {selectedAnomaly && (
                                <Badge variant="outline" className="text-base border-purple-500 text-purple-400">
                                    Trace: {selectedAnomaly.traceId.slice(0, 8)}...
                                </Badge>
                            )}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {selectedAnomaly ? (
                            <div className="space-y-5">
                                <div className="flex gap-3">
                                    <Button
                                        onClick={() => analyzeMutation.mutate(selectedAnomaly.traceId)}
                                        disabled={analyzeMutation.isPending}
                                        className="bg-purple-600 hover:bg-purple-700 text-base px-5 py-2"
                                    >
                                        {analyzeMutation.isPending ? "Analyzing..." : "Analyze with Ollama"}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        onClick={handleClearSelection}
                                        className="border-slate-600 text-base"
                                        style={{ color: 'white' }}
                                    >
                                        Clear
                                    </Button>
                                </div>

                                {analyzeMutation.data && (analyzeMutation.data as any).status === 'processing' && (
                                    <div className="bg-slate-800 rounded-lg p-5 space-y-4 border border-slate-700">
                                        <div className="flex items-center gap-3">
                                            <div className="animate-spin h-5 w-5 border-2 border-emerald-400 border-t-transparent rounded-full" />
                                            <div className="text-base text-emerald-400 font-medium">Analysis in progress...</div>
                                        </div>
                                        <div className="text-sm text-slate-400">Results will stream in the Live Analysis panel via WebSocket.</div>
                                    </div>
                                )}

                                {analyzeMutation.data && analyzeMutation.data.summary && (
                                    <div className="bg-slate-800 rounded-lg p-5 space-y-4 border border-slate-700">
                                        <div>
                                            <div className="text-base text-slate-400 mb-2 font-medium">Summary</div>
                                            <div className="text-base text-white leading-relaxed">{analyzeMutation.data.summary}</div>
                                        </div>

                                        {analyzeMutation.data.possibleCauses?.length > 0 && (
                                            <div>
                                                <div className="text-base text-slate-400 mb-2 font-medium">Possible Causes</div>
                                                <ul className="list-disc list-inside text-base text-white space-y-2">
                                                    {analyzeMutation.data.possibleCauses.map((cause: string, i: number) => (
                                                        <li key={i} className="leading-relaxed">{cause}</li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}

                                        {analyzeMutation.data.recommendations?.length > 0 && (
                                            <div>
                                                <div className="text-base text-slate-400 mb-2 font-medium">Recommendations</div>
                                                <ul className="list-disc list-inside text-base text-emerald-400 space-y-2">
                                                    {analyzeMutation.data.recommendations.map((rec: string, i: number) => (
                                                        <li key={i} className="leading-relaxed">{rec}</li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}

                                        <div className="flex items-center gap-3 pt-2">
                                            <span className="text-slate-400 text-base">Confidence:</span>
                                            <Badge
                                                variant="outline"
                                                className={`text-base px-3 ${analyzeMutation.data.confidence === 'high'
                                                    ? 'border-emerald-500 text-emerald-400'
                                                    : analyzeMutation.data.confidence === 'medium'
                                                        ? 'border-amber-500 text-amber-400'
                                                        : 'border-slate-500 text-slate-400'
                                                    }`}
                                            >
                                                {analyzeMutation.data.confidence}
                                            </Badge>
                                        </div>

                                        {/* Rating Buttons */}
                                        <div className="flex items-center gap-3 pt-3 border-t border-slate-700">
                                            <span className="text-slate-400 text-base">Rate this analysis:</span>
                                            <button
                                                onClick={() => ratingMutation.mutate({ rating: 'good' })}
                                                disabled={ratingMutation.isPending || ratingSuccess !== null}
                                                className="px-4 py-2 rounded-md bg-emerald-900/50 border border-emerald-700 text-emerald-400 hover:bg-emerald-800/50 disabled:opacity-50 transition-colors"
                                            >
                                                {ratingSuccess === 'good' ? '✓ Saved!' : '👍 Good'}
                                            </button>
                                            <button
                                                onClick={() => setShowCorrectionModal(true)}
                                                disabled={ratingMutation.isPending || ratingSuccess !== null}
                                                className="px-4 py-2 rounded-md bg-red-900/50 border border-red-700 text-red-400 hover:bg-red-800/50 disabled:opacity-50 transition-colors"
                                            >
                                                {ratingSuccess === 'bad' ? '✓ Saved!' : '👎 Bad'}
                                            </button>
                                            {trainingStats && (
                                                <span className="ml-auto text-sm text-slate-500">
                                                    {trainingStats.totalExamples} examples collected
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* Correction Modal */}
                                {showCorrectionModal && (
                                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                                        <div className="bg-slate-900 border border-slate-700 rounded-lg p-6 w-full max-w-2xl mx-4">
                                            <h3 className="text-xl font-semibold text-white mb-4">Provide Correction</h3>
                                            <p className="text-slate-400 mb-4">
                                                How should the AI have responded? Your correction will be used to improve future analysis.
                                            </p>
                                            <textarea
                                                value={correctionText}
                                                onChange={(e) => setCorrectionText(e.target.value)}
                                                placeholder="Enter the correct analysis..."
                                                className="w-full h-40 bg-slate-800 border border-slate-700 rounded-lg p-3 text-white resize-none focus:outline-none focus:border-purple-500"
                                            />
                                            <div className="flex gap-3 mt-4 justify-end">
                                                <button
                                                    onClick={() => {
                                                        setShowCorrectionModal(false);
                                                        setCorrectionText('');
                                                    }}
                                                    className="px-4 py-2 rounded-md border border-slate-600 text-slate-300 hover:bg-slate-800"
                                                >
                                                    Cancel
                                                </button>
                                                <button
                                                    onClick={() => ratingMutation.mutate({ rating: 'bad', correction: correctionText })}
                                                    disabled={!correctionText.trim() || ratingMutation.isPending}
                                                    className="px-4 py-2 rounded-md bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
                                                >
                                                    {ratingMutation.isPending ? 'Saving...' : 'Submit Correction'}
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="text-slate-400 text-center py-10 text-lg">
                                Click on an anomaly above to analyze it with AI
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Correlated Metrics Panel */}
                <Card className="bg-slate-800/50 backdrop-blur border-cyan-500/30 shadow-xl mt-6">
                    <CardHeader className="pb-4">
                        <CardTitle className="text-cyan-100 text-xl font-semibold flex items-center gap-3">
                            Correlated Metrics
                            {correlationMutation.isPending && (
                                <span className="text-cyan-400/70 text-sm font-normal">Loading...</span>
                            )}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {selectedAnomaly ? (
                            correlationMutation.data ? (
                                <div className="space-y-4">
                                    {/* Metrics Grid */}
                                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                                        {/* CPU */}
                                        <div className="bg-slate-900/50 rounded-lg p-4 border border-cyan-500/20">
                                            <div className="text-cyan-400/70 text-sm mb-1">CPU Usage</div>
                                            <div className={`text-2xl font-bold ${(correlationMutation.data.metrics.cpuPercent ?? 0) >= 80
                                                ? 'text-red-400'
                                                : (correlationMutation.data.metrics.cpuPercent ?? 0) >= 60
                                                    ? 'text-amber-400'
                                                    : 'text-emerald-400'
                                                }`}>
                                                {correlationMutation.data.metrics.cpuPercent !== null
                                                    ? `${correlationMutation.data.metrics.cpuPercent.toFixed(1)}%`
                                                    : 'N/A'}
                                            </div>
                                        </div>

                                        {/* Memory */}
                                        <div className="bg-slate-900/50 rounded-lg p-4 border border-cyan-500/20">
                                            <div className="text-cyan-400/70 text-sm mb-1">Memory</div>
                                            <div className={`text-2xl font-bold ${(correlationMutation.data.metrics.memoryMB ?? 0) >= 512
                                                ? 'text-amber-400'
                                                : 'text-emerald-400'
                                                }`}>
                                                {correlationMutation.data.metrics.memoryMB !== null
                                                    ? `${correlationMutation.data.metrics.memoryMB.toFixed(0)}MB`
                                                    : 'N/A'}
                                            </div>
                                        </div>

                                        {/* Request Rate */}
                                        <div className="bg-slate-900/50 rounded-lg p-4 border border-cyan-500/20">
                                            <div className="text-cyan-400/70 text-sm mb-1">Request Rate</div>
                                            <div className="text-2xl font-bold text-cyan-100">
                                                {correlationMutation.data.metrics.requestRate !== null
                                                    ? `${correlationMutation.data.metrics.requestRate.toFixed(1)}/s`
                                                    : 'N/A'}
                                            </div>
                                        </div>

                                        {/* Error Rate */}
                                        <div className="bg-slate-900/50 rounded-lg p-4 border border-cyan-500/20">
                                            <div className="text-cyan-400/70 text-sm mb-1">Error Rate</div>
                                            <div className={`text-2xl font-bold ${(correlationMutation.data.metrics.errorRate ?? 0) >= 5
                                                ? 'text-red-400'
                                                : (correlationMutation.data.metrics.errorRate ?? 0) >= 1
                                                    ? 'text-amber-400'
                                                    : 'text-emerald-400'
                                                }`}>
                                                {correlationMutation.data.metrics.errorRate !== null
                                                    ? `${correlationMutation.data.metrics.errorRate.toFixed(1)}%`
                                                    : '0%'}
                                            </div>
                                        </div>

                                        {/* P99 Latency */}
                                        <div className="bg-slate-900/50 rounded-lg p-4 border border-cyan-500/20">
                                            <div className="text-cyan-400/70 text-sm mb-1">P99 Latency</div>
                                            <div className="text-2xl font-bold text-cyan-100">
                                                {correlationMutation.data.metrics.p99LatencyMs !== null
                                                    ? `${correlationMutation.data.metrics.p99LatencyMs.toFixed(0)}ms`
                                                    : 'N/A'}
                                            </div>
                                        </div>

                                        {/* Active Connections */}
                                        <div className="bg-slate-900/50 rounded-lg p-4 border border-cyan-500/20">
                                            <div className="text-cyan-400/70 text-sm mb-1">Connections</div>
                                            <div className={`text-2xl font-bold ${(correlationMutation.data.metrics.activeConnections ?? 0) >= 100
                                                ? 'text-amber-400'
                                                : 'text-cyan-100'
                                                }`}>
                                                {correlationMutation.data.metrics.activeConnections !== null
                                                    ? correlationMutation.data.metrics.activeConnections
                                                    : 'N/A'}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Auto-Insights */}
                                    {correlationMutation.data.insights.length > 0 && (
                                        <div className="bg-amber-900/30 rounded-lg p-4 border border-amber-700/50">
                                            <div className="text-amber-400 font-semibold mb-2">Auto-Insights</div>
                                            <ul className="space-y-1">
                                                {correlationMutation.data.insights.map((insight, i) => (
                                                    <li key={i} className="text-white text-base">{insight}</li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}

                                    {/* Healthy indicator */}
                                    {correlationMutation.data.insights.length === 0 && (
                                        <div className="bg-emerald-900/30 rounded-lg p-4 border border-emerald-700/50 text-center">
                                            <span className="text-emerald-400">✅ No obvious resource issues detected at time of anomaly</span>
                                        </div>
                                    )}
                                </div>
                            ) : correlationMutation.isPending ? (
                                <div className="text-slate-400 text-center py-6 text-lg">
                                    Fetching correlated metrics...
                                </div>
                            ) : (
                                <div className="text-slate-400 text-center py-6 text-lg">
                                    Unable to fetch metrics (is Prometheus running?)
                                </div>
                            )
                        ) : (
                            <div className="text-slate-400 text-center py-10 text-lg">
                                Select an anomaly to see correlated metrics
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Whale Detection - Amount Anomalies */}
                <Card className="bg-slate-800/50 backdrop-blur border-amber-500/30 shadow-xl mt-6">
                    <CardHeader className="pb-4">
                        <div className="flex items-center justify-between">
                            <CardTitle className="text-amber-100 text-xl font-semibold flex items-center gap-3">
                                🐋 Whale Detection
                                {amountAnomaliesData?.active && amountAnomaliesData.active.length > 0 && (
                                    <Badge className="bg-amber-600 text-white text-base px-3">
                                        {amountAnomaliesData.active.length}
                                    </Badge>
                                )}
                            </CardTitle>
                            <Badge className={`${amountAnomaliesData?.enabled ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500/30' : 'bg-slate-600/20 text-slate-400 border-slate-500/30'} border`}>
                                {amountAnomaliesData?.enabled ? 'Active' : 'Disabled'}
                            </Badge>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3 max-h-72 overflow-y-auto">
                            {amountAnomaliesData?.active?.map((anomaly) => {
                                const sevBadge = getSeverityBadge(anomaly.severity);
                                return (
                                    <div
                                        key={anomaly.id}
                                        className="p-4 rounded-lg bg-amber-950/30 border border-amber-600/30 hover:bg-amber-950/50 transition-all"
                                    >
                                        <div className="flex justify-between items-start">
                                            <div>
                                                <div className="flex items-center gap-2 mb-1">
                                                    <Badge className={`${sevBadge.className} text-xs px-2 py-0.5`}>
                                                        {sevBadge.label}
                                                    </Badge>
                                                    <span className="text-amber-400 font-bold">{anomaly.operationType}</span>
                                                    <span className="text-slate-400">•</span>
                                                    <span className="text-white font-medium">{anomaly.asset}</span>
                                                </div>
                                                <div className="font-mono text-lg text-white font-bold mt-1">
                                                    {anomaly.amount.toLocaleString()} {anomaly.asset}
                                                    <span className="text-emerald-400 ml-2 text-base">
                                                        (${anomaly.dollarValue.toLocaleString(undefined, { minimumFractionDigits: 2 })})
                                                    </span>
                                                </div>
                                                <div className="text-sm text-slate-300 mt-1">
                                                    {anomaly.reason}
                                                </div>
                                                <div className="text-xs text-amber-400/70 mt-1">
                                                    {anomaly.deviation.toFixed(1)}σ from mean ({anomaly.expectedMean.toLocaleString()} avg)
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <div className="text-slate-300 text-sm">{formatTime(anomaly.timestamp)}</div>
                                                <div className="text-xs text-slate-500 mt-1 font-mono">
                                                    {anomaly.userId.slice(0, 20)}...
                                                </div>
                                                {anomaly.traceId && (
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        className="text-xs h-6 px-2 mt-1 text-cyan-400 hover:text-cyan-300"
                                                        onClick={() => window.open(getJaegerTraceUrl(anomaly.traceId!), "_blank")}
                                                    >
                                                        View Trace →
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                            {(!amountAnomaliesData?.active || amountAnomaliesData.active.length === 0) && (
                                <div className="text-slate-400 text-center py-10 text-lg">
                                    ✅ No whale transactions detected
                                </div>
                            )}
                        </div>
                    </CardContent>
                </Card>

                {/* Baselines Table */}

                <Card className="bg-slate-800/50 backdrop-blur border-cyan-500/30 shadow-xl mt-6">
                    <CardHeader className="pb-4">
                        <CardTitle className="text-cyan-100 text-xl font-semibold">
                            Baseline Statistics
                            {baselinesData?.baselines && (
                                <span className="text-base font-normal text-cyan-400/70 ml-3">
                                    ({baselinesData.baselines.length} spans tracked)
                                </span>
                            )}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow className="border-cyan-500/20 hover:bg-transparent">
                                        <TableHead className="text-cyan-100 text-base font-semibold">Span</TableHead>
                                        <TableHead className="text-cyan-100 text-base font-semibold text-center">Status</TableHead>
                                        <TableHead className="text-cyan-100 text-base font-semibold text-right">Mean</TableHead>
                                        <TableHead className="text-cyan-100 text-base font-semibold text-right">Std Dev (σ)</TableHead>
                                        <TableHead className="text-cyan-100 text-base font-semibold text-right">P95</TableHead>
                                        <TableHead className="text-cyan-100 text-base font-semibold text-right">P99</TableHead>
                                        <TableHead className="text-cyan-100 text-base font-semibold text-right">Samples</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {baselinesData?.baselines?.slice(0, 15).map((baseline, index) => (
                                        <TableRow
                                            key={baseline.spanKey}
                                            className={`border-cyan-500/20 ${index % 2 === 0 ? 'bg-slate-900/30' : 'bg-slate-900/50'} hover:bg-slate-800/50 transition-colors`}
                                        >
                                            <TableCell className="font-mono text-base py-3">
                                                <span className="text-cyan-400 font-medium">{baseline.service}</span>
                                                <span className="text-cyan-500/50 mx-1">:</span>
                                                <span className="text-cyan-100">{baseline.operation}</span>
                                            </TableCell>
                                            <TableCell className="text-center">
                                                <div className="flex items-center justify-center gap-2">
                                                    <DeviationMiniChart
                                                        currentValue={baseline.statusIndicator?.recentMean ?? baseline.mean}
                                                        mean={baseline.mean}
                                                        stdDev={baseline.stdDev}
                                                        deviation={baseline.statusIndicator?.deviation}
                                                        status={baseline.statusIndicator?.status}
                                                        width={80}
                                                        height={28}
                                                    />
                                                    <BaselineStatusBadge indicator={baseline.statusIndicator} size="sm" />
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-right text-base text-cyan-100 font-medium">
                                                {formatDuration(baseline.mean)}
                                            </TableCell>
                                            <TableCell className="text-right text-base text-cyan-300/70">
                                                ±{formatDuration(baseline.stdDev)}
                                            </TableCell>
                                            <TableCell className="text-right text-base text-cyan-100">
                                                {formatDuration(baseline.p95)}
                                            </TableCell>
                                            <TableCell className="text-right text-base text-cyan-100">
                                                {formatDuration(baseline.p99)}
                                            </TableCell>
                                            <TableCell className="text-right text-base text-cyan-300/70">
                                                {baseline.sampleCount.toLocaleString()}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                            {(!baselinesData?.baselines || baselinesData.baselines.length === 0) && (
                                <div className="text-cyan-400/70 text-center py-10 text-lg">
                                    Collecting baseline data from Jaeger...
                                </div>
                            )}
                        </div>
                    </CardContent>
                </Card>
            </div>
        </Layout >
    );
}
