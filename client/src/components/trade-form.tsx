import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { trace, context, SpanStatusCode } from "@opentelemetry/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { getJaegerTraceUrl } from "@/lib/trace-utils";
import { TradeVerifiedModal } from "@/components/trade-verified-modal";
import { ArrowUpRight, ArrowDownRight, Wallet, TrendingUp, Loader2, Bitcoin, CheckCircle2, Clock, ExternalLink, Lock, CheckCircle } from "lucide-react";

// Type-safe error message extraction
const getErrorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : 'An error occurred';

// Order schema
const orderSchema = z.object({
    pair: z.literal("BTC/USD"),
    side: z.enum(["BUY", "SELL"]),
    quantity: z.number().positive().max(100000000),
    orderType: z.literal("MARKET"),
});

type OrderFormData = z.infer<typeof orderSchema>;

interface WalletData {
    btc: number;
    usd: number;
    btcValue: number;
    totalValue: number;
    lastUpdated: string;
    address?: string;  // Krystaline wallet address (kx1...)
}

interface PriceData {
    pair: string;
    price: number;
    change24h: number;
    timestamp: string;
}

interface TradeFormProps {
    currentUser?: string;
    walletAddress?: string;  // Optional kx1 address
}

// Helper to format wallet address for display
function formatAddress(address: string): string {
    if (!address || address.length < 12) return address;
    return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

export function TradeForm({ currentUser: propUser, walletAddress: propAddress }: TradeFormProps) {
    const [side, setSide] = useState<"BUY" | "SELL">("BUY");
    const [lastTrade, setLastTrade] = useState<{
        traceId: string;
        orderId: string;
        side: string;
        quantity: number;
        fillPrice: number;
        executionTimeMs: number;
        timestamp: Date;
    } | null>(null);
    const [showVerifiedModal, setShowVerifiedModal] = useState(false);
    const [zkVerifyState, setZkVerifyState] = useState<{
        status: 'idle' | 'verifying' | 'verified' | 'pending';
        data?: { tradeHash: string; publicSignals: string[]; verifiedAt: string };
    }>({ status: 'idle' });
    const [verifiedTradeData, setVerifiedTradeData] = useState<{
        tradeId: string;
        traceId?: string;
        side: 'BUY' | 'SELL';
        amount: number;
        asset: string;
        price: number;
        executionTimeMs?: number;
    } | null>(null);
    const { toast } = useToast();
    const queryClient = useQueryClient();

    // Get user synchronously from localStorage on mount to avoid race conditions
    const [currentUser, setCurrentUser] = useState<string | null>(() => {
        if (propUser) return propUser;
        try {
            const userData = localStorage.getItem('user');
            if (userData) {
                const parsed = JSON.parse(userData);
                console.log('[TradeForm] User from localStorage:', parsed);
                console.log('[TradeForm] Extracted ID:', parsed.id);
                // Only accept UUID format - no email fallback
                return parsed.id || null;
            }
        } catch { /* ignore parse errors */ }
        return null;
    });

    const [walletAddress, setWalletAddress] = useState<string | undefined>(() => {
        if (propAddress) return propAddress;
        try {
            const userData = localStorage.getItem('user');
            if (userData) {
                const parsed = JSON.parse(userData);
                return parsed.walletAddress;
            }
        } catch { /* ignore parse errors */ }
        return undefined;
    });


    // Fetch wallet balance for current user
    const kongUrl = import.meta.env.VITE_KONG_URL || '';
    const { data: wallet } = useQuery<WalletData>({
        queryKey: ["/api/v1/wallet", { userId: currentUser }],
        queryFn: async () => {
            const res = await fetch(`${kongUrl}/api/v1/wallet?userId=${currentUser}`);
            return res.json();
        },
        refetchInterval: 5000,
    });

    // Fetch current price
    const { data: priceData } = useQuery<PriceData>({
        queryKey: ["/api/v1/price"],
        refetchInterval: 3000,
    });

    const form = useForm<OrderFormData>({
        resolver: zodResolver(orderSchema),
        defaultValues: {
            pair: "BTC/USD",
            side: "BUY",
            quantity: 0.01,
            orderType: "MARKET",
        },
    });

    // Update form when side changes
    useEffect(() => {
        form.setValue("side", side);
    }, [side, form]);

    const orderMutation = useMutation({
        mutationFn: async (data: OrderFormData) => {
            const tracer = trace.getTracer('kx-wallet');
            const token = localStorage.getItem('accessToken');

            // Create a parent span for the entire order flow on the client
            return tracer.startActiveSpan('order.submit.client', async (parentSpan) => {
                // Save the parent context before async operations
                const parentContext = context.active();

                try {
                    parentSpan.setAttribute('order.side', data.side);
                    parentSpan.setAttribute('order.quantity', data.quantity);
                    parentSpan.setAttribute('order.pair', data.pair);

                    // DEBUG: Log what we're about to send
                    console.log('[TradeForm] Submitting order with currentUser:', currentUser);
                    console.log('[TradeForm] currentUser type:', typeof currentUser);
                    console.log('[TradeForm] Order payload:', { ...data, userId: currentUser });

                    // Route through Kong Gateway for proper API gateway tracing
                    const response = await fetch(`${kongUrl}/api/v1/orders`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`,
                        },
                        body: JSON.stringify({ ...data, userId: currentUser }),
                    });

                    const result = await response.json();

                    if (!response.ok) {
                        // Check for 401 and redirect instead of showing toast
                        if (response.status === 401) {
                            localStorage.removeItem('accessToken');
                            localStorage.removeItem('refreshToken');
                            localStorage.removeItem('user');
                            window.location.href = '/';
                            return;
                        }
                        throw new Error(result.error || 'Order failed');
                    }

                    // Create a child span for response processing, explicitly within parent context
                    context.with(trace.setSpan(parentContext, parentSpan), () => {
                        const responseSpan = tracer.startSpan('order.response.received');
                        responseSpan.setAttribute('order.id', result.orderId || 'unknown');
                        responseSpan.setAttribute('order.status', result.execution?.status || 'PENDING');
                        responseSpan.setAttribute('order.fillPrice', result.execution?.fillPrice || 0);
                        responseSpan.setStatus({ code: SpanStatusCode.OK });
                        responseSpan.end();
                    });

                    parentSpan.setStatus({ code: SpanStatusCode.OK });
                    return result;
                } catch (error: unknown) {
                    parentSpan.setStatus({ code: SpanStatusCode.ERROR, message: getErrorMessage(error) });
                    throw error;
                } finally {
                    parentSpan.end();
                }
            });
        },
        onSuccess: (data) => {
            const execution = data.execution;
            const traceId = data.traceId;

            // Store last trade for visual feedback
            setLastTrade({
                traceId,
                orderId: data.orderId || data.order?.id || '',
                side: data.order.side,
                quantity: data.order.quantity,
                fillPrice: execution?.fillPrice || 0,
                executionTimeMs: execution?.executionTimeMs || 0,
                timestamp: new Date(),
            });

            // Reset ZK verify state for new trade
            setZkVerifyState({ status: 'idle' });

            // Clear success state after 10 seconds
            setTimeout(() => setLastTrade(null), 10000);

            // Show verified modal for prominent trace link
            setVerifiedTradeData({
                tradeId: data.orderId || data.order.id,
                traceId,
                side: data.order.side,
                amount: data.order.quantity,
                asset: 'BTC',
                price: execution?.fillPrice || 0,
                executionTimeMs: execution?.executionTimeMs,
            });
            setShowVerifiedModal(true);

            toast({
                title: execution?.status === 'FILLED' ? "✓ Trade Verified & Traced" : "Order Submitted",
                description: (
                    <div className="space-y-3">
                        <div className="p-3 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
                            <div className="flex items-center justify-between text-sm">
                                <span className="font-mono font-medium">
                                    {data.order.side} {data.order.quantity.toFixed(6)} BTC
                                </span>
                                {execution && (
                                    <span className="font-bold text-emerald-400">@ ${execution.fillPrice?.toLocaleString()}</span>
                                )}
                            </div>
                            {execution && (
                                <div className="flex items-center justify-between text-xs mt-2 text-slate-400">
                                    <span>Total: ${execution.totalValue?.toFixed(2)}</span>
                                    <span className="flex items-center gap-1 text-amber-400">
                                        <Clock className="w-3 h-3" />
                                        {execution.executionTimeMs || '< 1'}ms
                                    </span>
                                </div>
                            )}
                        </div>
                        <a
                            href={getJaegerTraceUrl(traceId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center justify-center gap-2 w-full py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-lg text-sm font-medium transition-all shadow-lg shadow-purple-500/25"
                        >
                            <ExternalLink className="w-4 h-4" />
                            View Full Trace in Jaeger
                        </a>
                        <p className="text-xs text-center text-slate-500">
                            Trace ID: {traceId.slice(0, 16)}...
                        </p>
                    </div>
                ),
            });

            // Refresh data - use partial match to invalidate all wallet queries
            queryClient.invalidateQueries({ queryKey: ["/api/v1/wallet"], exact: false });
            queryClient.invalidateQueries({ queryKey: ["/api/v1/orders"] });
            queryClient.invalidateQueries({ queryKey: ["/api/v1/traces"] });

            setTimeout(() => {
                queryClient.invalidateQueries({ queryKey: ["/api/v1/traces"] });
            }, 1500);
        },
        onError: (error: any) => {
            // Parse error response for semantic status codes
            const status = error.response?.status;
            const errorData = error.response?.data || {};

            if (status === 422 && errorData.code === 'INSUFFICIENT_FUNDS') {
                toast({
                    title: "Insufficient Funds",
                    description: `You need ${errorData.details?.required} ${errorData.details?.asset} but only have ${errorData.details?.available}`,
                    variant: "destructive",
                });
            } else if (status === 503 && errorData.code === 'SERVICE_UNAVAILABLE') {
                toast({
                    title: "Service Unavailable",
                    description: "Trading is temporarily unavailable. Please try again later.",
                    variant: "destructive",
                });
            } else if (status === 400) {
                toast({
                    title: "Invalid Request",
                    description: errorData.error || "Please check your input and try again.",
                    variant: "destructive",
                });
            } else {
                toast({
                    title: "Order Failed",
                    description: errorData.error || error.message || "An error occurred",
                    variant: "destructive",
                });
            }
        },
    });

    const onSubmit = (data: OrderFormData) => {
        orderMutation.mutate(data);
    };

    // Handle null prices (Binance disconnected)
    const priceAvailable = priceData?.price !== null && priceData?.price !== undefined;
    const currentPrice = priceAvailable ? priceData.price : 0;
    const quantity = form.watch("quantity") || 0;
    const estimatedValue = priceAvailable ? quantity * currentPrice : 0;

    return (
        <Card className="w-full bg-slate-900 border-slate-700 text-white">
            <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-lg font-bold flex items-center gap-2">
                        <Bitcoin className="w-5 h-5 text-orange-500" />
                        BTC/USD Trade
                    </CardTitle>
                    <div className="flex items-center gap-2">
                        {priceAvailable ? (
                            <>
                                <TrendingUp className="w-4 h-4 text-green-400" />
                                <span className="text-lg font-mono font-bold text-green-400">
                                    ${currentPrice.toLocaleString()}
                                </span>
                            </>
                        ) : (
                            <span className="text-sm text-amber-400 animate-pulse">
                                Waiting for pricing feed...
                            </span>
                        )}
                    </div>
                </div>
            </CardHeader>

            <CardContent className="space-y-5">
                {/* Success Banner - Shows after trade */}
                {lastTrade && (
                    <div className="animate-in slide-in-from-top-2 duration-300 p-4 bg-slate-800/70 rounded-xl border border-emerald-500/30">
                        <div className="flex items-start gap-3">
                            <div className="p-2 bg-emerald-500/20 rounded-full">
                                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                            </div>
                            <div className="flex-1">
                                <div className="flex items-center justify-between">
                                    <h4 className="font-semibold text-emerald-400">Trade Executed & Traced</h4>
                                    <span className="text-xs text-amber-400 flex items-center gap-1">
                                        <Clock className="w-3 h-3" />
                                        {lastTrade.executionTimeMs || '< 1'}ms
                                    </span>
                                </div>
                                <p className="text-sm text-slate-300 mt-1">
                                    {lastTrade.side} {lastTrade.quantity.toFixed(6)} BTC @ ${lastTrade.fillPrice.toLocaleString()}
                                </p>
                                <div className="flex items-center gap-3 mt-2">
                                    <a
                                        href={getJaegerTraceUrl(lastTrade.traceId)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300"
                                    >
                                        <ExternalLink className="w-3 h-3" />
                                        View trace: {lastTrade.traceId.slice(0, 12)}...
                                    </a>
                                    {lastTrade.orderId && zkVerifyState.status === 'idle' && (
                                        <button
                                            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-purple-500/15 border border-purple-500/30 text-purple-300 hover:bg-purple-500/25 transition-colors"
                                            onClick={async () => {
                                                setZkVerifyState({ status: 'verifying' });
                                                try {
                                                    const res = await fetch(`/api/v1/public/zk/verify/${lastTrade.orderId}`);
                                                    if (res.ok) {
                                                        const result = await res.json();
                                                        if (result.verified) {
                                                            setZkVerifyState({ status: 'verified', data: result });
                                                        } else {
                                                            setZkVerifyState({ status: 'pending' });
                                                        }
                                                    } else {
                                                        setZkVerifyState({ status: 'pending' });
                                                    }
                                                } catch {
                                                    setZkVerifyState({ status: 'pending' });
                                                }
                                            }}
                                        >
                                            <Lock className="w-3 h-3" />
                                            Verify ZK Proof
                                        </button>
                                    )}
                                    {zkVerifyState.status === 'verifying' && (
                                        <span className="inline-flex items-center gap-1 text-xs text-purple-300">
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                            Verifying...
                                        </span>
                                    )}
                                    {zkVerifyState.status === 'verified' && (
                                        <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                                            <CheckCircle className="w-3 h-3" />
                                            ZK Proof ✓
                                        </span>
                                    )}
                                    {zkVerifyState.status === 'pending' && (
                                        <span className="inline-flex items-center gap-1 text-xs text-amber-300">
                                            <Clock className="w-3 h-3" />
                                            Proof pending
                                        </span>
                                    )}
                                </div>
                                {/* Expanded ZK proof details */}
                                {zkVerifyState.status === 'verified' && zkVerifyState.data && (
                                    <div className="mt-3 pt-3 border-t border-emerald-500/20">
                                        <div className="bg-slate-900/80 rounded-lg p-3 space-y-1.5 text-xs">
                                            <div className="flex items-center gap-2 mb-2">
                                                <CheckCircle className="w-3 h-3 text-emerald-400" />
                                                <span className="text-emerald-400 font-semibold">Groth16 zk-SNARK — Trade Integrity</span>
                                            </div>
                                            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                                                <span className="text-slate-500">Circuit:</span>
                                                <span className="text-slate-300 font-mono text-[11px]">trade_integrity (BN128)</span>
                                                <span className="text-slate-500">Hash:</span>
                                                <code className="text-purple-300 font-mono bg-slate-800/50 px-1 rounded text-[11px] break-all">{zkVerifyState.data.tradeHash}</code>
                                                <span className="text-slate-500">Signals:</span>
                                                <div className="space-y-0.5">
                                                    {zkVerifyState.data.publicSignals?.slice(0, 3).map((s, i) => (
                                                        <code key={i} className="block text-cyan-300 font-mono bg-slate-800/50 px-1 rounded text-[11px] break-all">
                                                            [{i}] {s.length > 20 ? s.slice(0, 10) + '…' + s.slice(-10) : s}
                                                        </code>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}



                {/* Buy/Sell Toggle */}
                <div className="grid grid-cols-2 gap-2">
                    <Button
                        type="button"
                        variant={side === "BUY" ? "default" : "outline"}
                        className={`h-12 ${side === "BUY"
                            ? "bg-green-600 hover:bg-green-700 text-white"
                            : "border-slate-600 text-slate-400 hover:bg-slate-800"}`}
                        onClick={() => setSide("BUY")}
                    >
                        <ArrowUpRight className="w-5 h-5 mr-2" />
                        BUY
                    </Button>
                    <Button
                        type="button"
                        variant={side === "SELL" ? "default" : "outline"}
                        className={`h-12 ${side === "SELL"
                            ? "bg-red-600 hover:bg-red-700 text-white"
                            : "border-slate-600 text-slate-400 hover:bg-slate-800"}`}
                        onClick={() => setSide("SELL")}
                    >
                        <ArrowDownRight className="w-5 h-5 mr-2" />
                        SELL
                    </Button>
                </div>

                {/* Order Form */}
                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                        <FormField
                            control={form.control}
                            name="quantity"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel className="text-slate-300">Amount (BTC)</FormLabel>
                                    <FormControl>
                                        <Input
                                            type="number"
                                            step="0.001"
                                            min="0.001"
                                            max="100000000"
                                            placeholder="0.01"
                                            {...field}
                                            onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                                            className="bg-slate-800 border-slate-600 text-white font-mono text-lg h-12"
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        {/* Estimated Value */}
                        <div className="p-3 bg-slate-800 rounded-lg">
                            <div className="flex justify-between items-center">
                                <span className="text-sm text-slate-400">Estimated Value</span>
                                <span className="font-mono font-bold text-lg">
                                    ${estimatedValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </span>
                            </div>
                        </div>

                        {/* Submit Button */}
                        <Button
                            type="submit"
                            disabled={orderMutation.isPending || !priceAvailable || !currentUser}
                            className={`w-full h-14 text-lg font-bold ${side === "BUY"
                                ? "bg-green-600 hover:bg-green-700 disabled:bg-green-600/50"
                                : "bg-red-600 hover:bg-red-700 disabled:bg-red-600/50"
                                }`}
                        >
                            {orderMutation.isPending ? (
                                <>
                                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                                    Processing...
                                </>
                            ) : !currentUser ? (
                                <>Please log in to trade</>
                            ) : !priceAvailable ? (
                                <>Waiting for prices...</>
                            ) : (
                                <>
                                    {side === "BUY" ? "Buy" : "Sell"} {quantity.toFixed(4)} BTC
                                </>
                            )}
                        </Button>
                    </form>
                </Form>
            </CardContent>

            {/* Trade Verified Modal */}
            {verifiedTradeData && (
                <TradeVerifiedModal
                    isOpen={showVerifiedModal}
                    onClose={() => setShowVerifiedModal(false)}
                    tradeId={verifiedTradeData.tradeId}
                    traceId={verifiedTradeData.traceId}
                    side={verifiedTradeData.side}
                    amount={verifiedTradeData.amount}
                    asset={verifiedTradeData.asset}
                    price={verifiedTradeData.price}
                    executionTimeMs={verifiedTradeData.executionTimeMs}
                />
            )}
        </Card>
    );
}
