import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Layout from "@/components/Layout";
import { WelcomeModal, useWelcomeModal } from "@/components/welcome-modal";
import { Sparkles, ArrowRight, TrendingUp, Eye, Zap } from "lucide-react";

interface Wallet {
    asset: string;
    balance: string;
    available: string;
    locked: string;
}

interface User {
    id: string;
    email: string;
    status: string;
    kyc_level: number;
}

interface PriceData {
    BTC: number;
    ETH: number;
    source: string;
}

export default function Portfolio() {
    const [, navigate] = useLocation();
    const { t } = useTranslation(['dashboard', 'trading']);
    const [user, setUser] = useState<User | null>(null);
    const [isNewUser, setIsNewUser] = useState(false);
    const { isOpen: showWelcome, close: closeWelcome } = useWelcomeModal();

    // Asset icons and colors - use translations for names
    const getAssetConfig = (asset: string) => {
        const configs: Record<string, { icon: string; color: string }> = {
            BTC: { icon: "₿", color: "text-orange-400" },
            ETH: { icon: "Ξ", color: "text-purple-400" },
            USDT: { icon: "₮", color: "text-emerald-400" },
            USD: { icon: "$", color: "text-green-400" },
            EUR: { icon: "€", color: "text-blue-400" },
        };
        return {
            icon: configs[asset]?.icon || "?",
            color: configs[asset]?.color || "text-slate-400",
            name: t(`trading:assets.${asset}`, asset),
        };
    };

    useEffect(() => {
        const storedUser = localStorage.getItem("user");
        if (!storedUser) {
            navigate("/login");
            return;
        }
        setUser(JSON.parse(storedUser));

        // Check if this is a new user who hasn't traded yet
        const newUserFlag = localStorage.getItem("isNewUser");
        const hasTraded = localStorage.getItem("hasCompletedFirstTrade");
        setIsNewUser(newUserFlag === "true" && !hasTraded);
    }, [navigate]);

    // Fetch real prices from Binance API
    const { data: priceData } = useQuery<PriceData>({
        queryKey: ["/api/v1/price"],
        refetchInterval: 3000, // Update every 3 seconds
    });

    const { data: walletsData, isLoading } = useQuery<{ wallets: Wallet[] }>({
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
        enabled: !!user,
    });

    // Get rate for an asset using real Binance prices
    const getRate = (asset: string): number => {
        if (priceData) {
            if (asset === 'BTC') return priceData.BTC;
            if (asset === 'ETH') return priceData.ETH;
        }
        // Fallback for stablecoins
        if (asset === 'USDT' || asset === 'USD') return 1;
        if (asset === 'EUR') return 1.1;
        return 0;
    };

    // Calculate total balance in USD using real prices
    const calculateTotalUSD = () => {
        if (!walletsData?.wallets) return 0;
        return walletsData.wallets.reduce((total, w) => {
            const rate = getRate(w.asset);
            return total + parseFloat(w.balance) * rate;
        }, 0);
    };

    if (!user) return null;

    return (
        <Layout>
            {/* Welcome Modal for new users */}
            <WelcomeModal isOpen={showWelcome} onClose={closeWelcome} />

            <div className="container mx-auto px-4 py-8">
                {/* Total Balance Card */}
                <Card className="bg-slate-800/60 border-cyan-500/30 mb-8 backdrop-blur">
                    <CardContent className="py-8">
                        <div className="text-center">
                            <p className="text-cyan-100/60 mb-2">{t('portfolio.totalBalance')}</p>
                            <p className="text-5xl font-bold text-cyan-100">
                                ${calculateTotalUSD().toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </p>
                        </div>
                    </CardContent>
                </Card>

                {/* First Trade CTA for New Users */}
                {isNewUser && (
                    <Card className="bg-slate-800/60 border-purple-500/30 mb-8 overflow-hidden relative">
                        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-purple-500/10 via-transparent to-transparent" />
                        <CardContent className="py-6 relative">
                            <div className="flex flex-col md:flex-row items-center gap-6">
                                <div className="p-4 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-600 shadow-xl shadow-purple-500/25">
                                    <Sparkles className="w-8 h-8 text-white" />
                                </div>
                                <div className="flex-1 text-center md:text-left">
                                    <h3 className="text-2xl font-bold text-white mb-2">
                                        {t('portfolio.firstTrade.title')} 🚀
                                    </h3>
                                    <p className="text-purple-100/70 mb-4 max-w-lg">
                                        {t('portfolio.firstTrade.subtitle')}
                                    </p>
                                    <div className="flex flex-wrap items-center justify-center md:justify-start gap-3 text-sm text-purple-200/60">
                                        <span className="flex items-center gap-1">
                                            <Zap className="w-4 h-4 text-yellow-400" /> {t('metrics.avgExecutionTime')}
                                        </span>
                                        <span className="flex items-center gap-1">
                                            <Eye className="w-4 h-4 text-cyan-400" /> {t('hero.title')}
                                        </span>
                                        <span className="flex items-center gap-1">
                                            <TrendingUp className="w-4 h-4 text-green-400" /> {t('metrics.totalTrades')}
                                        </span>
                                    </div>
                                </div>
                                <Button
                                    size="lg"
                                    onClick={() => navigate("/trade?welcome=true")}
                                    className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-lg px-8 py-6 shadow-xl shadow-purple-500/25 group"
                                >
                                    {t('portfolio.firstTrade.cta')}
                                    <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                )}

                {/* Quick Actions */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                    <Button
                        className="h-16 bg-emerald-600 hover:bg-emerald-700 text-lg font-semibold"
                        onClick={() => navigate("/trade")}
                    >
                        {t('portfolio.deposit')}
                    </Button>
                    <Button
                        className="h-16 bg-blue-600 hover:bg-blue-700 text-lg font-semibold"
                        onClick={() => navigate("/trade")}
                    >
                        {t('portfolio.withdraw')}
                    </Button>
                    <Button
                        className="h-16 bg-cyan-600 hover:bg-cyan-700 text-lg font-semibold"
                        onClick={() => navigate("/convert")}
                    >
                        {t('portfolio.convert')}
                    </Button>
                    <Button
                        className="h-16 bg-indigo-600 hover:bg-indigo-700 text-lg font-semibold"
                        onClick={() => navigate("/trade")}
                    >
                        {t('portfolio.trade')}
                    </Button>
                </div>

                {/* Wallets Grid */}
                <h2 className="text-2xl font-semibold text-cyan-100 mb-4">{t('portfolio.yourAssets')}</h2>

                {isLoading ? (
                    <div className="text-center py-8 text-slate-400">{t('common:buttons.loading')}</div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {walletsData?.wallets.map((wallet) => {
                            const config = getAssetConfig(wallet.asset);
                            const balance = parseFloat(wallet.balance);
                            const usdValue = balance * getRate(wallet.asset);

                            return (
                                <Card key={wallet.asset} className="bg-slate-800/50 border-cyan-500/30 hover:border-cyan-400/50 transition-all backdrop-blur">
                                    <CardContent className="p-6">
                                        <div className="flex items-center gap-4">
                                            <div className={`text-4xl ${config.color}`}>
                                                {config.icon}
                                            </div>
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-semibold text-white text-lg">{wallet.asset}</span>
                                                    <span className="text-slate-400 text-sm">{config.name}</span>
                                                </div>
                                                <div className="text-2xl font-bold text-white">
                                                    {parseFloat(wallet.balance).toLocaleString(undefined, {
                                                        minimumFractionDigits: wallet.asset === 'BTC' ? 8 : 2,
                                                        maximumFractionDigits: wallet.asset === 'BTC' ? 8 : 2,
                                                    })}
                                                </div>
                                                <div className="text-sm text-slate-400">
                                                    ≈ ${usdValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                </div>
                                            </div>
                                        </div>
                                        {parseFloat(wallet.locked) > 0 && (
                                            <div className="mt-4 text-sm text-amber-400">
                                                🔒 {wallet.locked} locked in orders
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>
                            );
                        })}
                    </div>
                )}
            </div>
        </Layout>
    );
}
