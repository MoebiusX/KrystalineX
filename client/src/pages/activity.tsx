import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Layout from "@/components/Layout";
import {
    ArrowUpRight,
    ArrowDownRight,
    Send,
    Eye,
    Clock,
    CheckCircle2,
    XCircle,
    Filter,
    RefreshCw,
    Lock,
    CheckCircle
} from "lucide-react";
import type { Order, Transfer } from "@shared/schema";
import { getJaegerTraceUrl } from "@/lib/trace-utils";

interface User {
    id: string;
    email: string;
    status: string;
}

type ActivityType = 'all' | 'trades' | 'transfers';

export default function Activity() {
    const [, navigate] = useLocation();
    const { t } = useTranslation(['common', 'trading']);
    const [user, setUser] = useState<User | null>(null);
    const [filter, setFilter] = useState<ActivityType>('all');
    const [selectedTrace, setSelectedTrace] = useState<string | null>(null);
    const [verifyingTrade, setVerifyingTrade] = useState<string | null>(null);
    const [verifiedTrades, setVerifiedTrades] = useState<Set<string>>(new Set());
    const [pendingTrades, setPendingTrades] = useState<Set<string>>(new Set());

    useEffect(() => {
        const storedUser = localStorage.getItem("user");
        if (!storedUser) {
            navigate("/login");
            return;
        }
        setUser(JSON.parse(storedUser));
    }, [navigate]);

    const { data: orders, isLoading: ordersLoading, refetch: refetchOrders } = useQuery<Order[]>({
        queryKey: ["/api/v1/orders"],
        refetchInterval: 5000,
        enabled: !!user,
    });

    const { data: transfers, isLoading: transfersLoading, refetch: refetchTransfers } = useQuery<Transfer[]>({
        queryKey: ["/api/v1/transfers"],
        refetchInterval: 5000,
        enabled: !!user,
    });

    const { data: priceData } = useQuery<{ BTC: number; ETH: number }>({
        queryKey: ["/api/v1/price"],
        refetchInterval: 3000,
    });

    // Combine and sort activities by date
    const activities = [
        ...(filter === 'transfers' ? [] : (orders || []).map(o => ({ ...o, type: 'order' as const }))),
        ...(filter === 'trades' ? [] : (transfers || []).map(t => ({ ...t, type: 'transfer' as const }))),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const getStatusIcon = (status: string) => {
        if (status === 'FILLED' || status === 'COMPLETED' || status === 'completed') {
            return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
        }
        if (status === 'REJECTED' || status === 'FAILED') {
            return <XCircle className="w-4 h-4 text-red-400" />;
        }
        return <Clock className="w-4 h-4 text-yellow-400 animate-pulse" />;
    };

    const getStatusBadge = (status: string) => {
        const colors: Record<string, string> = {
            'FILLED': 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
            'COMPLETED': 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
            'completed': 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
            'PENDING': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
            'pending': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
            'REJECTED': 'bg-red-500/20 text-red-400 border-red-500/30',
            'FAILED': 'bg-red-500/20 text-red-400 border-red-500/30',
        };
        return colors[status] || 'bg-slate-500/20 text-slate-400 border-slate-500/30';
    };

    const formatTime = (date: Date | string) => {
        const d = new Date(date);
        return d.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    const handleRefresh = () => {
        refetchOrders();
        refetchTransfers();
    };

    if (!user) return null;

    const isLoading = ordersLoading || transfersLoading;

    return (
        <Layout>
            <div className="container mx-auto px-4 py-8">
                {/* Header */}
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8">
                    <div>
                        <h1 className="text-3xl font-bold text-cyan-100">{t('common:nav.activity')}</h1>
                        <p className="text-cyan-100/60 mt-1">
                            {t('trading:proofOfObservability.description')}
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
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

                {/* Filters */}
                <div className="flex gap-2 mb-6">
                    <Button
                        variant={filter === 'all' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setFilter('all')}
                        className={filter === 'all'
                            ? 'bg-cyan-600 hover:bg-cyan-700 text-white'
                            : 'bg-slate-800 border-slate-600 text-slate-200 hover:bg-slate-700 hover:text-white'}
                    >
                        <Filter className="w-4 h-4 mr-2" />
                        All Activity
                    </Button>
                    <Button
                        variant={filter === 'trades' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setFilter('trades')}
                        className={filter === 'trades'
                            ? 'bg-green-600 hover:bg-green-700 text-white'
                            : 'bg-slate-800 border-slate-600 text-slate-200 hover:bg-slate-700 hover:text-white'}
                    >
                        <ArrowUpRight className="w-4 h-4 mr-2" />
                        Trades
                    </Button>
                    <Button
                        variant={filter === 'transfers' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setFilter('transfers')}
                        className={filter === 'transfers'
                            ? 'bg-purple-600 hover:bg-purple-700 text-white'
                            : 'bg-slate-800 border-slate-600 text-slate-200 hover:bg-slate-700 hover:text-white'}
                    >
                        <Send className="w-4 h-4 mr-2" />
                        Transfers
                    </Button>
                </div>

                {/* Activity List */}
                {isLoading ? (
                    <div className="space-y-4">
                        {[1, 2, 3].map(i => (
                            <Card key={i} className="bg-slate-800/50 border-cyan-500/20 animate-pulse">
                                <CardContent className="p-6">
                                    <div className="h-16 bg-slate-700/50 rounded" />
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                ) : activities.length === 0 ? (
                    <Card className="bg-gradient-to-br from-slate-800/50 to-slate-900/50 border-cyan-500/20">
                        <CardContent className="py-16 text-center">
                            <div className="relative inline-block mb-6">
                                <Clock className="w-16 h-16 text-cyan-500/30" />
                                <div className="absolute inset-0 animate-ping">
                                    <Clock className="w-16 h-16 text-cyan-500/10" />
                                </div>
                            </div>
                            <h3 className="text-xl font-semibold text-cyan-100 mb-2">Your Activity Awaits</h3>
                            <p className="text-cyan-100/50 mb-1">
                                Every trade you make is recorded with full transparency.
                            </p>
                            <p className="text-cyan-100/40 text-sm mb-6 max-w-md mx-auto">
                                View execution times, trace IDs, and verification status for each transaction.
                            </p>
                            <Button
                                className="bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 shadow-lg shadow-cyan-500/25"
                                onClick={() => navigate('/trade')}
                            >
                                Make Your First Trade
                            </Button>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="space-y-3">
                        {activities.map((activity) => {
                            const isOrder = activity.type === 'order';
                            const order = isOrder ? (activity as Order) : null;
                            const transfer = !isOrder ? (activity as Transfer) : null;
                            const traceId = order?.traceId || transfer?.traceId;

                            return (
                                <Card
                                    key={isOrder ? order?.orderId : transfer?.transferId}
                                    className={`bg-slate-800/50 border-cyan-500/20 hover:border-cyan-400/40 transition-all ${selectedTrace === traceId ? 'ring-2 ring-cyan-500' : ''
                                        }`}
                                >
                                    <CardContent className="p-4 md:p-6">
                                        <div className="flex flex-col md:flex-row md:items-center gap-4">
                                            {/* Icon & Type */}
                                            <div className="flex items-center gap-4 flex-1">
                                                <div className={`p-3 rounded-xl ${isOrder
                                                    ? order?.side === 'BUY'
                                                        ? 'bg-emerald-500/20'
                                                        : 'bg-red-500/20'
                                                    : 'bg-purple-500/20'
                                                    }`}>
                                                    {isOrder ? (
                                                        order?.side === 'BUY'
                                                            ? <ArrowUpRight className="w-6 h-6 text-emerald-400" />
                                                            : <ArrowDownRight className="w-6 h-6 text-red-400" />
                                                    ) : (
                                                        <Send className="w-6 h-6 text-purple-400" />
                                                    )}
                                                </div>

                                                <div className="flex-1">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <span className={`font-semibold ${isOrder
                                                            ? order?.side === 'BUY'
                                                                ? 'text-emerald-400'
                                                                : 'text-red-400'
                                                            : 'text-purple-400'
                                                            }`}>
                                                            {isOrder
                                                                ? `${order?.side} ${order?.pair}`
                                                                : 'Transfer BTC'
                                                            }
                                                        </span>
                                                        <Badge
                                                            variant="outline"
                                                            className={getStatusBadge(
                                                                isOrder ? order?.status || '' : transfer?.status || ''
                                                            )}
                                                        >
                                                            {getStatusIcon(isOrder ? order?.status || '' : transfer?.status || '')}
                                                            <span className="ml-1">
                                                                {isOrder ? order?.status : transfer?.status}
                                                            </span>
                                                        </Badge>
                                                    </div>

                                                    <div className="text-sm text-cyan-100/60 mt-1">
                                                        {isOrder ? (
                                                            <>
                                                                {order?.quantity?.toFixed(6)} BTC @ $
                                                                {order?.fillPrice?.toLocaleString() || priceData?.BTC.toLocaleString() || 'Market'}
                                                            </>
                                                        ) : (
                                                            <>
                                                                {transfer?.amount?.toFixed(6)} BTC •
                                                                {transfer?.fromUserId} → {transfer?.toUserId}
                                                            </>
                                                        )}
                                                    </div>

                                                    <div className="text-xs text-cyan-100/40 mt-1">
                                                        {formatTime(activity.createdAt)}
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Value & Actions */}
                                            <div className="flex items-center gap-4 md:gap-6">
                                                <div className="text-right">
                                                    <div className="font-mono text-lg text-cyan-100">
                                                        {isOrder
                                                            ? `$${((order?.quantity || 0) * (order?.fillPrice || priceData?.BTC || 0)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                                                            : `${transfer?.amount?.toFixed(6)} BTC`
                                                        }
                                                    </div>
                                                </div>

                                                {/* View Trace - The Key Feature! */}
                                                {traceId && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => {
                                                            setSelectedTrace(traceId);
                                                            window.open(getJaegerTraceUrl(traceId), '_blank');
                                                        }}
                                                        className="border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/20 hover:border-cyan-400"
                                                    >
                                                        <Eye className="w-4 h-4 mr-2" />
                                                        View Trace
                                                    </Button>
                                                )}

                                                {/* ZK Proof Verify Button */}
                                                {isOrder && order?.status === 'FILLED' && (
                                                    verifiedTrades.has(order.orderId) ? (
                                                        <span
                                                            className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                                                            title="Groth16 zk-SNARK trade integrity proof verified — price, quantity, and user hash match on-chain commitment"
                                                        >
                                                            <CheckCircle className="w-3.5 h-3.5" />
                                                            ZK Proof ✓
                                                        </span>
                                                    ) : (
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            disabled={verifyingTrade === order.orderId}
                                                            onClick={async () => {
                                                                setVerifyingTrade(order.orderId);
                                                                try {
                                                                    const res = await fetch(`/api/v1/public/zk/verify/${order.orderId}`);
                                                                    if (res.ok) {
                                                                        const result = await res.json();
                                                                        if (result.verified) {
                                                                            setVerifiedTrades(prev => new Set(prev).add(order.orderId));
                                                                        } else {
                                                                            setPendingTrades(prev => new Set(prev).add(order.orderId));
                                                                        }
                                                                    } else {
                                                                        setPendingTrades(prev => new Set(prev).add(order.orderId));
                                                                    }
                                                                } catch {
                                                                    setPendingTrades(prev => new Set(prev).add(order.orderId));
                                                                } finally {
                                                                    setVerifyingTrade(null);
                                                                }
                                                            }}
                                                            className={pendingTrades.has(order.orderId)
                                                                ? 'border-amber-500/40 text-amber-300 hover:bg-amber-500/20'
                                                                : 'border-purple-500/40 text-purple-300 hover:bg-purple-500/20 hover:border-purple-400'
                                                            }
                                                        >
                                                            <Lock className="w-4 h-4 mr-2" />
                                                            {verifyingTrade === order.orderId ? 'Verifying...' : pendingTrades.has(order.orderId) ? 'Pending' : 'Verify Proof'}
                                                        </Button>
                                                    )
                                                )}
                                            </div>
                                        </div>

                                        {/* Trace ID Display */}
                                        {traceId && (
                                            <div className="mt-3 pt-3 border-t border-cyan-500/10">
                                                <div className="flex items-center gap-2 text-xs">
                                                    <span className="text-cyan-100/40">Trace ID:</span>
                                                    <code className="font-mono text-cyan-400/80 bg-slate-900/50 px-2 py-1 rounded">
                                                        {traceId}
                                                    </code>
                                                </div>
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>
                            );
                        })}
                    </div>
                )}

                {/* Transparency Notice */}
                <Card className="mt-8 bg-slate-800/60 border-cyan-500/20">
                    <CardContent className="p-6">
                        <div className="flex items-start gap-4">
                            <div className="p-3 bg-cyan-500/20 rounded-xl">
                                <Eye className="w-6 h-6 text-cyan-400" />
                            </div>
                            <div>
                                <h3 className="font-semibold text-cyan-100 mb-1">
                                    Proof of Observability™
                                </h3>
                                <p className="text-cyan-100/60 text-sm">
                                    Every transaction has a unique Trace ID. Click "View Trace" to see
                                    exactly how your order was processed - from API gateway to database.
                                    This is real-time transparency, not just a promise.
                                </p>
                                <Button
                                    variant="link"
                                    className="text-cyan-400 hover:text-cyan-300 p-0 h-auto mt-2"
                                    onClick={() => navigate('/transparency')}
                                >
                                    Learn more about our transparency →
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </Layout>
    );
}
