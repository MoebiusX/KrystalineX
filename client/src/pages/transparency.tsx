import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Layout from "@/components/Layout";
import {
    Activity,
    CheckCircle2,
    AlertTriangle,
    Clock,
    Server,
    Zap,
    Eye,
    TrendingUp,
    Shield,
    Database,
    Cpu,
    RefreshCw
} from "lucide-react";

// Service Health Interface
interface ServiceHealth {
    name: string;
    status: 'healthy' | 'warning' | 'critical' | 'unknown';
    avgDuration: number;
    spanCount: number;
    activeAnomalies: number;
    lastSeen: string;
}

// Baseline Interface
interface SpanBaseline {
    service: string;
    operation: string;
    mean: number;
    p95: number;
    p99: number;
    sampleCount: number;
}

// Friendly service name mapping
// NOTE: When renaming services, update BOTH the kx-* names AND legacy fallbacks
// See docs/TRACING.md for the full service naming convention
const SERVICE_DISPLAY_NAMES: Record<string, { name: string; description: string; icon: React.ReactNode }> = {
    'kx-exchange': {
        name: 'Trading Engine',
        description: 'Core trading engine processing orders',
        icon: <TrendingUp className="w-5 h-5" />
    },
    'exchange-api': {  // Legacy fallback
        name: 'Trading API',
        description: 'Core trading engine processing orders',
        icon: <TrendingUp className="w-5 h-5" />
    },
    'api-gateway': {
        name: 'API Gateway',
        description: 'Request routing and rate limiting',
        icon: <Server className="w-5 h-5" />
    },
    'postgres': {
        name: 'Database',
        description: 'Transaction storage and wallet data',
        icon: <Database className="w-5 h-5" />
    },
    'rabbitmq': {
        name: 'Message Queue',
        description: 'Order processing pipeline',
        icon: <Zap className="w-5 h-5" />
    },
    'kx-matcher': {
        name: 'Order Matcher',
        description: 'Order matching and execution engine',
        icon: <Zap className="w-5 h-5" />
    },
    'order-matcher': {  // Legacy fallback
        name: 'Order Matcher',
        description: 'Order matching and execution engine',
        icon: <Zap className="w-5 h-5" />
    },
    'jaeger-all-in-one': {
        name: 'Trace Collector',
        description: 'Observability data collection',
        icon: <Eye className="w-5 h-5" />
    },
    'kx-wallet': {
        name: 'Wallet Service',
        description: 'Balance management and transfers',
        icon: <Shield className="w-5 h-5" />
    },
    'crypto-wallet': {  // Legacy fallback
        name: 'Wallet Service',
        description: 'Balance management and transfers',
        icon: <Shield className="w-5 h-5" />
    },
};

export default function TransparencyPage() {
    const [lastRefresh, setLastRefresh] = useState(new Date());
    const { t } = useTranslation(['trading', 'common']);

    // Fetch service health
    const { data: healthData, refetch: refetchHealth, isLoading: healthLoading } = useQuery<{ services: ServiceHealth[] }>({
        queryKey: ["/api/v1/monitor/health"],
        refetchInterval: 10000,
    });

    // Fetch baselines summary
    const { data: baselinesData, isLoading: baselinesLoading } = useQuery<{ baselines: SpanBaseline[] }>({
        queryKey: ["/api/v1/monitor/baselines"],
        refetchInterval: 30000,
    });

    // Calculate overall system status
    const calculateSystemStatus = () => {
        if (!healthData?.services) return { status: 'unknown', color: 'bg-slate-500' };

        const criticalCount = healthData.services.filter(s => s.status === 'critical').length;
        const warningCount = healthData.services.filter(s => s.status === 'warning').length;
        const healthyCount = healthData.services.filter(s => s.status === 'healthy').length;

        if (criticalCount > 0) return { status: 'Issues Detected', color: 'bg-red-500', text: 'text-red-400' };
        if (warningCount > 0) return { status: 'Minor Issues', color: 'bg-yellow-500', text: 'text-yellow-400' };
        if (healthyCount === healthData.services.length) return { status: 'All Systems Operational', color: 'bg-emerald-500', text: 'text-emerald-400' };
        return { status: 'Checking...', color: 'bg-slate-500', text: 'text-slate-400' };
    };

    const systemStatus = calculateSystemStatus();

    // Calculate average response time
    const avgResponseTime = healthData?.services?.reduce((sum, s) => sum + s.avgDuration, 0)
        ? Math.round(healthData.services.reduce((sum, s) => sum + s.avgDuration, 0) / healthData.services.length)
        : 0;

    const handleRefresh = () => {
        refetchHealth();
        setLastRefresh(new Date());
    };

    const formatDuration = (ms: number) => {
        if (ms < 1) return '<1ms';
        if (ms < 1000) return `${Math.round(ms)}ms`;
        return `${(ms / 1000).toFixed(2)}s`;
    };

    const getStatusIcon = (status: string) => {
        switch (status) {
            case 'healthy': return <CheckCircle2 className="w-5 h-5 text-emerald-400" />;
            case 'warning': return <AlertTriangle className="w-5 h-5 text-yellow-400" />;
            case 'critical': return <AlertTriangle className="w-5 h-5 text-red-400" />;
            default: return <Clock className="w-5 h-5 text-slate-400" />;
        }
    };

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'healthy': return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
            case 'warning': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
            case 'critical': return 'bg-red-500/20 text-red-400 border-red-500/30';
            default: return 'bg-slate-500/20 text-slate-400 border-slate-500/30';
        }
    };

    return (
        <Layout>
            <div className="container mx-auto px-4 py-8">
                {/* Header */}
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8">
                    <div>
                        <h1 className="text-3xl font-bold text-cyan-100">{t('trading:transparency.title')}</h1>
                        <p className="text-cyan-100/60 mt-1">
                            {t('trading:transparency.subtitle')}
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        <span className="text-xs text-cyan-100/40">
                            Updated {lastRefresh.toLocaleTimeString()}
                        </span>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleRefresh}
                            className="border-cyan-500/30 text-cyan-100 hover:bg-cyan-500/10"
                        >
                            <RefreshCw className="w-4 h-4 mr-2" />
                            {t('common:buttons.refresh')}
                        </Button>
                    </div>
                </div>

                {/* System Status Banner */}
                <Card className={`mb-8 border-2 ${systemStatus.color}/30 bg-gradient-to-r from-slate-900 to-slate-800`}>
                    <CardContent className="py-6">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-4">
                                <div className={`p-3 rounded-xl ${systemStatus.color}/20`}>
                                    <Activity className={`w-8 h-8 ${systemStatus.text}`} />
                                </div>
                                <div>
                                    <h2 className={`text-2xl font-bold ${systemStatus.text}`}>
                                        {systemStatus.status}
                                    </h2>
                                    <p className="text-cyan-100/60 text-sm">
                                        {healthData?.services?.length || 0} services monitored •
                                        {' '}Avg response: {formatDuration(avgResponseTime)}
                                    </p>
                                </div>
                            </div>
                            <div className="hidden md:block text-right">
                                <div className="text-3xl font-bold text-cyan-100">99.9%</div>
                                <div className="text-cyan-100/60 text-sm">Uptime</div>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Key Metrics */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                    <Card className="bg-slate-800/50 border-cyan-500/20">
                        <CardContent className="p-4 text-center">
                            <Cpu className="w-8 h-8 mx-auto mb-2 text-cyan-400" />
                            <div className="text-2xl font-bold text-cyan-100">
                                {healthData?.services?.length || '-'}
                            </div>
                            <div className="text-cyan-100/60 text-sm">Active Services</div>
                        </CardContent>
                    </Card>
                    <Card className="bg-slate-800/50 border-cyan-500/20">
                        <CardContent className="p-4 text-center">
                            <Zap className="w-8 h-8 mx-auto mb-2 text-yellow-400" />
                            <div className="text-2xl font-bold text-cyan-100">
                                {formatDuration(avgResponseTime)}
                            </div>
                            <div className="text-cyan-100/60 text-sm">Avg Response</div>
                        </CardContent>
                    </Card>
                    <Card className="bg-slate-800/50 border-cyan-500/20">
                        <CardContent className="p-4 text-center">
                            <Database className="w-8 h-8 mx-auto mb-2 text-purple-400" />
                            <div className="text-2xl font-bold text-cyan-100">
                                {baselinesData?.baselines?.length || '-'}
                            </div>
                            <div className="text-cyan-100/60 text-sm">Operations Tracked</div>
                        </CardContent>
                    </Card>
                    <Card className="bg-slate-800/50 border-cyan-500/20">
                        <CardContent className="p-4 text-center">
                            <Shield className="w-8 h-8 mx-auto mb-2 text-emerald-400" />
                            <div className="text-2xl font-bold text-cyan-100">
                                {healthData?.services?.filter(s => s.status === 'healthy').length || 0}
                            </div>
                            <div className="text-cyan-100/60 text-sm">Healthy Services</div>
                        </CardContent>
                    </Card>
                </div>

                {/* Services Grid */}
                <h2 className="text-xl font-semibold text-cyan-100 mb-4 flex items-center gap-2">
                    <Server className="w-5 h-5 text-cyan-400" />
                    Service Health
                </h2>

                {healthLoading ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {[1, 2, 3, 4, 5, 6].map(i => (
                            <Card key={i} className="bg-slate-800/50 border-cyan-500/20 animate-pulse">
                                <CardContent className="p-6">
                                    <div className="h-20 bg-slate-700/50 rounded" />
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
                        {healthData?.services?.map((service) => {
                            const displayInfo = SERVICE_DISPLAY_NAMES[service.name] || {
                                name: service.name,
                                description: 'System component',
                                icon: <Cpu className="w-5 h-5" />
                            };

                            return (
                                <Card
                                    key={service.name}
                                    className={`bg-slate-800/50 border-cyan-500/20 hover:border-cyan-400/40 transition-all`}
                                >
                                    <CardContent className="p-5">
                                        <div className="flex items-start justify-between mb-3">
                                            <div className="flex items-center gap-3">
                                                <div className={`p-2 rounded-lg ${service.status === 'healthy' ? 'bg-emerald-500/20 text-emerald-400' :
                                                    service.status === 'warning' ? 'bg-yellow-500/20 text-yellow-400' :
                                                        service.status === 'critical' ? 'bg-red-500/20 text-red-400' :
                                                            'bg-slate-500/20 text-slate-400'
                                                    }`}>
                                                    {displayInfo.icon}
                                                </div>
                                                <div>
                                                    <h3 className="font-semibold text-cyan-100">
                                                        {displayInfo.name}
                                                    </h3>
                                                    <p className="text-xs text-cyan-100/50">
                                                        {displayInfo.description}
                                                    </p>
                                                </div>
                                            </div>
                                            {getStatusIcon(service.status)}
                                        </div>

                                        <div className="grid grid-cols-2 gap-3 mt-4">
                                            <div>
                                                <div className="text-xs text-cyan-100/50">Response</div>
                                                <div className="font-mono text-cyan-100">
                                                    {formatDuration(service.avgDuration)}
                                                </div>
                                            </div>
                                            <div>
                                                <div className="text-xs text-cyan-100/50">Requests</div>
                                                <div className="font-mono text-cyan-100">
                                                    {service.spanCount.toLocaleString()}
                                                </div>
                                            </div>
                                        </div>

                                        <div className="mt-3 pt-3 border-t border-cyan-500/10">
                                            <Badge
                                                variant="outline"
                                                className={getStatusBadge(service.status)}
                                            >
                                                {service.status === 'healthy' ? '✓ Operational' :
                                                    service.status === 'warning' ? '⚠ Degraded' :
                                                        service.status === 'critical' ? '✕ Down' : 'Unknown'}
                                            </Badge>
                                        </div>
                                    </CardContent>
                                </Card>
                            );
                        })}
                    </div>
                )}

                {/* What We Monitor */}
                <Card className="bg-slate-800/60 border-cyan-500/20">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-cyan-100">
                            <Eye className="w-5 h-5 text-cyan-400" />
                            What We Monitor
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            <div>
                                <h4 className="font-semibold text-cyan-100 mb-2">Every Trade</h4>
                                <p className="text-cyan-100/60 text-sm">
                                    Each order generates a unique trace ID that tracks its journey
                                    from your click to execution. View this in your Activity page.
                                </p>
                            </div>
                            <div>
                                <h4 className="font-semibold text-cyan-100 mb-2">System Performance</h4>
                                <p className="text-cyan-100/60 text-sm">
                                    We continuously measure response times and detect anomalies.
                                    If something slows down, we know immediately.
                                </p>
                            </div>
                            <div>
                                <h4 className="font-semibold text-cyan-100 mb-2">Service Health</h4>
                                <p className="text-cyan-100/60 text-sm">
                                    All microservices are monitored 24/7. Issues are detected
                                    and addressed before they affect your experience.
                                </p>
                            </div>
                        </div>

                        <div className="mt-6 pt-6 border-t border-cyan-500/20 text-center">
                            <p className="text-cyan-100/70 text-sm">
                                This is <strong className="text-cyan-400">Proof of Observability™</strong> -
                                not just promises, but real-time visibility into how we handle your assets.
                            </p>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </Layout>
    );
}
