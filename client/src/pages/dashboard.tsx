import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { TradeForm } from "@/components/trade-form";
import { TransferForm } from "@/components/transfer-form";
import { TraceViewer } from "@/components/trace-viewer";
import { formatTimeAgo } from "@/lib/utils";
import { Bitcoin, TrendingUp, Wallet, ArrowUpRight, ArrowDownRight, Send, ArrowRightLeft, Sparkles, X, CheckCircle2, Eye, Zap, DollarSign, CreditCard, RefreshCw } from "lucide-react";
import type { Order, Transfer } from "@shared/schema";
import Layout from "@/components/Layout";
import { useLocation, useSearch } from "wouter";
import { getJaegerTraceUrl } from "@/lib/trace-utils";

// Types for portfolio
interface WalletData {
  asset: string;
  balance: string;
  available: string;
  locked: string;
}

interface PriceData {
  BTC: number;
  ETH: number;
  source: string;
}

// Asset configuration for display
const ASSET_CONFIG: Record<string, { icon: string; color: string; name: string }> = {
  BTC: { icon: "₿", color: "text-orange-400", name: "Bitcoin" },
  ETH: { icon: "Ξ", color: "text-purple-400", name: "Ethereum" },
  USDT: { icon: "₮", color: "text-emerald-400", name: "Tether" },
  USD: { icon: "$", color: "text-green-400", name: "US Dollar" },
  EUR: { icon: "€", color: "text-blue-400", name: "Euro" },
};

type TabType = 'trade' | 'transfer';

// Journey step indicator for new users
function JourneyProgress({ currentStep }: { currentStep: 1 | 2 | 3 | 4 }) {
  const steps = [
    { num: 1, label: 'Account Created', icon: CheckCircle2 },
    { num: 2, label: 'Make First Trade', icon: Zap },
    { num: 3, label: 'View Trace Proof', icon: Eye },
  ];

  return (
    <div className="flex items-center justify-center gap-2 mb-6">
      {steps.map((step, i) => (
        <div key={step.num} className="flex items-center">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all ${step.num < currentStep
            ? 'bg-green-500/20 text-green-400'
            : step.num === currentStep
              ? 'bg-cyan-500/20 text-cyan-400 ring-2 ring-cyan-500/50'
              : 'bg-slate-800 text-slate-500'
            }`}>
            {step.num < currentStep ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : (
              <step.icon className="w-4 h-4" />
            )}
            <span className="hidden sm:inline">{step.label}</span>
            <span className="sm:hidden">{step.num}</span>
          </div>
          {i < steps.length - 1 && (
            <div className={`w-8 h-0.5 mx-1 ${step.num < currentStep ? 'bg-green-500/50' : 'bg-slate-700'
              }`} />
          )}
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [, navigate] = useLocation();
  const searchString = useSearch();
  const [activeTab, setActiveTab] = useState<TabType>('trade');
  const [showWelcome, setShowWelcome] = useState(false);
  const [hasCompletedFirstTrade, setHasCompletedFirstTrade] = useState(false);
  const [hasViewedTrace, setHasViewedTrace] = useState(false);

  // Get current user from localStorage
  const [currentUser, setCurrentUser] = useState<string | null>(null);

  useEffect(() => {
    const userData = localStorage.getItem('user');
    if (userData) {
      try {
        const parsed = JSON.parse(userData);
        // FIXED: Use UUID as userId (not email!)
        setCurrentUser(parsed.id || null);

        if (!parsed.id) {
          console.error('[Dashboard] No valid UUID found in user data:', parsed);
          navigate('/login');
        }
      } catch {
        navigate('/login');
      }
    } else {
      navigate('/login');
    }

    // Check if user has already viewed a trace
    if (localStorage.getItem('hasViewedTrace') === 'true') {
      setHasViewedTrace(true);
    }
    // Check if user has already completed first trade
    if (localStorage.getItem('hasCompletedFirstTrade') === 'true') {
      setHasCompletedFirstTrade(true);
    }
  }, [navigate]);

  // Listen for traceViewed event from TraceViewer
  useEffect(() => {
    const handleTraceViewed = () => {
      setHasViewedTrace(true);
    };
    window.addEventListener('traceViewed', handleTraceViewed);
    return () => window.removeEventListener('traceViewed', handleTraceViewed);
  }, []);

  // Check for welcome flow (new user)
  useEffect(() => {
    const isNewUser = localStorage.getItem('isNewUser');
    const params = new URLSearchParams(searchString);
    if (isNewUser === 'true' || params.get('welcome') === 'true') {
      setShowWelcome(true);
      // Reset journey flags for genuinely new users so the progress starts fresh
      localStorage.removeItem('hasCompletedFirstTrade');
      localStorage.removeItem('hasViewedTrace');
      setHasCompletedFirstTrade(false);
      setHasViewedTrace(false);
    }
  }, [searchString]);

  const { data: orders, isLoading: ordersLoading } = useQuery<Order[]>({
    queryKey: ["/api/v1/orders", { userId: currentUser }],
    queryFn: async () => {
      const kongUrl = import.meta.env.VITE_KONG_URL || '';
      const res = await fetch(`${kongUrl}/api/v1/orders?userId=${currentUser}`);
      return res.json();
    },
    enabled: !!currentUser,
    refetchInterval: 3000,
  });

  const { data: transfers, isLoading: transfersLoading } = useQuery<Transfer[]>({
    queryKey: ["/api/v1/transfers", { userId: currentUser }],
    queryFn: async () => {
      const kongUrl = import.meta.env.VITE_KONG_URL || '';
      const res = await fetch(`${kongUrl}/api/v1/transfers?userId=${currentUser}`);
      return res.json();
    },
    enabled: !!currentUser,
    refetchInterval: 3000,
  });

  // Portfolio data - use SAME endpoint as trade form for consistency
  interface PortfolioSummary {
    btc: number;
    usd: number;
    btcValue: number;
    totalValue: number;
  }

  const { data: portfolio, isLoading: portfolioLoading } = useQuery<PortfolioSummary>({
    queryKey: ["/api/v1/wallet", { userId: currentUser }],
    queryFn: async () => {
      const kongUrl = import.meta.env.VITE_KONG_URL || '';
      const res = await fetch(`${kongUrl}/api/v1/wallet?userId=${currentUser}`);
      return res.json();
    },
    enabled: !!currentUser,
    refetchInterval: 5000,
  });

  // Also fetch detailed wallets as backup (for asset grid)
  const { data: walletsData, isLoading: walletsLoading } = useQuery<{ wallets: WalletData[] }>({
    queryKey: ["/api/v1/wallet/balances"],
    queryFn: async () => {
      const token = localStorage.getItem("accessToken");
      const res = await fetch("/api/v1/wallet/balances", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (res.status === 401) {
          localStorage.clear();
          navigate("/login");
        }
        throw new Error("Failed to fetch wallets");
      }
      return res.json();
    },
    enabled: !!currentUser,
    refetchInterval: 5000,
  });

  // Real-time price data from Binance
  const { data: priceData } = useQuery<PriceData>({
    queryKey: ["/api/v1/price"],
    refetchInterval: 3000,
  });

  // Helper: Get USD rate for an asset
  const getRate = (asset: string): number => {
    if (priceData) {
      if (asset === 'BTC') return priceData.BTC;
      if (asset === 'ETH') return priceData.ETH;
    }
    if (asset === 'USDT' || asset === 'USD') return 1;
    if (asset === 'EUR') return 1.1;
    return 0;
  };

  // Calculate total portfolio value - always use real Binance prices for accuracy
  const calculateTotalUSD = () => {
    if (portfolio) {
      // Always calculate using real Binance price, not backend's simulated totalValue
      const btcValue = (portfolio.btc ?? 0) * (priceData?.BTC || 0);
      const usdValue = portfolio.usd ?? 0;
      return btcValue + usdValue;
    }
    if (!walletsData?.wallets) return 0;
    return walletsData.wallets.reduce((total, w) => {
      const rate = getRate(w.asset);
      return total + parseFloat(w.balance) * rate;
    }, 0);
  };

  // Track first trade completion — only when order count INCREASES during this session
  const initialOrderCountRef = useRef<number | null>(null);
  useEffect(() => {
    if (orders == null) return;
    // Capture the initial order count on first load
    if (initialOrderCountRef.current === null) {
      initialOrderCountRef.current = orders.length;
      return;
    }
    // Only mark first trade if a NEW order appeared during this session
    if (orders.length > initialOrderCountRef.current) {
      const hadFirstTrade = localStorage.getItem('hasCompletedFirstTrade');
      if (!hadFirstTrade) {
        localStorage.setItem('hasCompletedFirstTrade', 'true');
        setHasCompletedFirstTrade(true);
      }
    }
  }, [orders]);

  const getStatusColor = (status: string, side?: string) => {
    if (status === 'FILLED' || status === 'COMPLETED' || status === 'completed') {
      if (side === 'BUY') return 'text-green-400';
      if (side === 'SELL') return 'text-red-400';
      return 'text-purple-400';
    }
    if (status === 'REJECTED' || status === 'FAILED') return 'text-red-500';
    return 'text-yellow-400';
  };

  return (
    <Layout>
      <div className="min-h-screen bg-slate-950">
        {/* Main Content */}
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">

          {/* Welcome Banner for New Users */}
          {showWelcome && (
            <div className="mb-8">
              <JourneyProgress currentStep={hasViewedTrace ? 4 : hasCompletedFirstTrade ? 3 : 2} />

              <Card className="bg-slate-800/70 border-cyan-500/30 relative overflow-hidden">
                <button
                  onClick={() => {
                    setShowWelcome(false);
                    localStorage.removeItem('isNewUser');
                  }}
                  className="absolute top-3 right-3 text-slate-400 hover:text-white transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>

                <CardContent className="py-6">
                  <div className="flex items-start gap-4">
                    <div className="p-3 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 shadow-lg shadow-cyan-500/25">
                      <Sparkles className="w-6 h-6 text-white" />
                    </div>
                    <div className="flex-1">
                      {!hasCompletedFirstTrade ? (
                        <>
                          <h3 className="text-xl font-bold text-white mb-1">Welcome to Krystaline! 🎉</h3>
                          <p className="text-cyan-100/70 mb-4">
                            You have <span className="text-cyan-400 font-semibold">$10,000 demo balance</span> to explore.
                            Make your first trade below and watch it get traced in real-time on the right.
                          </p>
                          <div className="flex items-center gap-3 text-sm">
                            <span className="flex items-center gap-1 text-emerald-400">
                              <CheckCircle2 className="w-4 h-4" /> Account verified
                            </span>
                            <span className="flex items-center gap-1 text-cyan-400 animate-pulse">
                              <Zap className="w-4 h-4" /> Ready to trade
                            </span>
                          </div>
                        </>
                      ) : (
                        <>
                          <h3 className="text-xl font-bold text-white mb-1">Trade Executed! 🚀</h3>
                          <p className="text-cyan-100/70 mb-4">
                            Your trade was captured with full observability. Check the <span className="text-cyan-400 font-semibold">Trace Viewer</span> on the right
                            to see every step - from order to settlement. Click any trace to open it in Jaeger.
                          </p>
                          <div className="flex items-center gap-3 text-sm">
                            <span className="flex items-center gap-1 text-emerald-400">
                              <CheckCircle2 className="w-4 h-4" /> First trade complete
                            </span>
                            <span className="flex items-center gap-1 text-purple-400">
                              <Eye className="w-4 h-4" /> Traces available
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">

            {/* Left Column - Trade/Transfer */}
            <div className="space-y-6">
              {/* Trade/Transfer Card with integrated tabs */}
              <Card className="bg-slate-900 border-slate-700">
                {/* Tab Header */}
                <div className="flex border-b border-slate-700">
                  <button
                    onClick={() => setActiveTab('trade')}
                    className={`flex-1 flex items-center justify-center gap-2 py-3 px-4 text-sm font-medium transition-colors ${activeTab === 'trade'
                      ? 'bg-green-600/20 text-green-400 border-b-2 border-green-400'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                      }`}
                  >
                    <ArrowRightLeft className="w-4 h-4" />
                    Trade BTC
                  </button>
                  <button
                    onClick={() => setActiveTab('transfer')}
                    className={`flex-1 flex items-center justify-center gap-2 py-3 px-4 text-sm font-medium transition-colors ${activeTab === 'transfer'
                      ? 'bg-purple-600/20 text-purple-400 border-b-2 border-purple-400'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                      }`}
                  >
                    <Send className="w-4 h-4" />
                    Transfer BTC
                  </button>
                </div>

                {/* Active Form Content */}
                <div className="p-0">
                  {!currentUser ? (
                    <div className="p-8">
                      <Skeleton className="h-32 w-full bg-slate-800" />
                    </div>
                  ) : activeTab === 'trade' ? (
                    <TradeForm currentUser={currentUser} />
                  ) : (
                    <TransferForm />
                  )}
                </div>
              </Card>

              {/* Recent Activity */}
              <Card className="bg-slate-900 border-slate-700">
                <CardHeader>
                  <CardTitle className="text-lg font-semibold text-white flex items-center gap-2">
                    <TrendingUp className="w-5 h-5 text-green-400" />
                    Recent Activity
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {(ordersLoading || transfersLoading) ? (
                    <div className="space-y-3">
                      {[...Array(3)].map((_, i) => (
                        <Skeleton key={i} className="h-16 w-full bg-slate-800" />
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {/* Orders */}
                      {orders?.slice(0, 3).map((order) => (
                        <div
                          key={order.orderId}
                          className="flex items-center justify-between p-3 bg-slate-800 rounded-lg group hover:bg-slate-750 transition-colors"
                        >
                          <div className="flex items-center gap-3">
                            {order.side === 'BUY' ? (
                              <ArrowUpRight className="w-5 h-5 text-green-400" />
                            ) : (
                              <ArrowDownRight className="w-5 h-5 text-red-400" />
                            )}
                            <div>
                              <p className={`font-medium ${order.side === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>
                                {order.side} {order.quantity?.toFixed(6)} BTC
                              </p>
                              <p className="text-sm text-slate-400">
                                {formatTimeAgo(new Date(order.createdAt))}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="text-right">
                              <p className="text-sm font-mono text-slate-300">
                                ${order.fillPrice?.toLocaleString() || 'Market'}
                              </p>
                              <p className={`text-sm font-medium ${getStatusColor(order.status, order.side)}`}>
                                {order.status}
                              </p>
                            </div>
                            {order.traceId && (
                              <a
                                href={getJaegerTraceUrl(order.traceId)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-2 bg-purple-500/20 hover:bg-purple-500/30 rounded-lg text-purple-400 hover:text-purple-300 transition-colors opacity-0 group-hover:opacity-100"
                                title="View trace in Jaeger"
                              >
                                <Eye className="w-4 h-4" />
                              </a>
                            )}
                          </div>
                        </div>
                      ))}

                      {/* Transfers */}
                      {transfers?.slice(0, 2).map((transfer) => (
                        <div
                          key={transfer.transferId}
                          className="flex items-center justify-between p-3 bg-slate-800 rounded-lg border-l-2 border-purple-500"
                        >
                          <div className="flex items-center gap-3">
                            <Send className="w-5 h-5 text-purple-400" />
                            <div>
                              <p className="font-medium text-purple-400">
                                Transfer {transfer.amount?.toFixed(6)} BTC
                              </p>
                              <p className="text-sm text-slate-400">
                                {transfer.fromUserId} → {transfer.toUserId}
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className={`text-sm font-medium ${getStatusColor(transfer.status)}`}>
                              {transfer.status}
                            </p>
                          </div>
                        </div>
                      ))}

                      {(!orders?.length && !transfers?.length) && (
                        <div className="text-center py-10">
                          <div className="relative inline-block mb-4">
                            <Wallet className="w-12 h-12 text-cyan-500/40" />
                            <div className="absolute inset-0 animate-ping">
                              <Wallet className="w-12 h-12 text-cyan-500/20" />
                            </div>
                          </div>
                          <p className="text-lg font-medium text-slate-300 mb-1">Ready to Start Trading</p>
                          <p className="text-sm text-slate-500 mb-4 max-w-xs mx-auto">
                            Use the form on the left to make your first trade. Each transaction is traced with OpenTelemetry.
                          </p>
                          <div className="flex items-center justify-center gap-2 text-xs text-purple-400/60">
                            <Eye className="w-3 h-3" />
                            <span>Traces will appear in real-time</span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Right Column - Portfolio + Traces */}
            <div className="space-y-6">
              {/* Portfolio Panel */}
              <Card className="bg-slate-800/60 border-cyan-500/30 backdrop-blur">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg font-semibold text-white flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Wallet className="w-5 h-5 text-cyan-400" />
                      Your Portfolio
                    </div>
                    {priceData && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-orange-400">₿</span>
                        <span className="text-slate-300">${priceData.BTC?.toLocaleString()}</span>
                      </div>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Total Balance */}
                  <div className="text-center py-4 bg-slate-800/50 rounded-xl border border-cyan-500/10">
                    <p className="text-cyan-100/60 text-sm mb-1">Total Balance (USD)</p>
                    <p className="text-4xl font-bold bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">
                      ${calculateTotalUSD().toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  </div>

                  {/* Asset Grid - Uses portfolio summary from API */}
                  {portfolioLoading ? (
                    <div className="grid grid-cols-2 gap-2">
                      {[...Array(2)].map((_, i) => (
                        <Skeleton key={i} className="h-16 bg-slate-800" />
                      ))}
                    </div>
                  ) : portfolio ? (
                    <div className="grid grid-cols-2 gap-2">
                      {/* BTC Balance */}
                      <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50 hover:border-orange-500/30 transition-colors">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-lg text-orange-400">₿</span>
                          <span className="font-medium text-white text-sm">BTC</span>
                        </div>
                        <p className="text-white font-semibold">
                          {(portfolio.btc ?? 0).toLocaleString(undefined, {
                            minimumFractionDigits: 6,
                            maximumFractionDigits: 6,
                          })}
                        </p>
                        <p className="text-slate-400 text-xs">
                          ≈ ${((portfolio.btc ?? 0) * (priceData?.BTC || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </p>
                      </div>

                      {/* USD Balance */}
                      <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50 hover:border-green-500/30 transition-colors">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-lg text-green-400">$</span>
                          <span className="font-medium text-white text-sm">USD</span>
                        </div>
                        <p className="text-white font-semibold">
                          {(portfolio.usd ?? 0).toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </p>
                        <p className="text-slate-400 text-xs">
                          Available
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-4 text-slate-400 text-sm">
                      Loading balances...
                    </div>
                  )}

                  {/* Quick Actions */}
                  <div className="grid grid-cols-3 gap-2 pt-2">
                    <Button
                      size="sm"
                      className="bg-emerald-600/80 hover:bg-emerald-600 text-white"
                      onClick={() => navigate('/convert')}
                    >
                      <DollarSign className="w-4 h-4 mr-1" />
                      Deposit
                    </Button>
                    <Button
                      size="sm"
                      className="bg-blue-600/80 hover:bg-blue-600 text-white"
                      onClick={() => navigate('/convert')}
                    >
                      <CreditCard className="w-4 h-4 mr-1" />
                      Withdraw
                    </Button>
                    <Button
                      size="sm"
                      className="bg-cyan-600/80 hover:bg-cyan-600 text-white"
                      onClick={() => navigate('/convert')}
                    >
                      <RefreshCw className="w-4 h-4 mr-1" />
                      Convert
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Trace Viewer */}
              <TraceViewer />
            </div>
          </div>
        </main>
      </div>
    </Layout>
  );
}
