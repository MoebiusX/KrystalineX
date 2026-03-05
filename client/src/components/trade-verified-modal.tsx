/**
 * Trade Verified Modal Component
 * 
 * Shown after a successful trade execution to emphasize the trace link.
 * This is KEY to demonstrating "Proof of Observability" - making the trace
 * the primary call-to-action, not just a secondary link.
 */

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { CheckCircle2, ExternalLink, TrendingUp, ArrowRight, Eye, Zap } from 'lucide-react';
import { getJaegerTraceUrl } from '@/lib/trace-utils';

interface TradeVerifiedModalProps {
    isOpen: boolean;
    onClose: () => void;
    tradeId: string;
    traceId?: string;
    side: 'BUY' | 'SELL';
    amount: number;
    asset: string;
    price: number;
    executionTimeMs?: number;
}

export function TradeVerifiedModal({
    isOpen,
    onClose,
    tradeId,
    traceId,
    side,
    amount,
    asset,
    price,
    executionTimeMs,
}: TradeVerifiedModalProps) {
    const { t } = useTranslation('trading');

    const handleViewTrace = () => {
        if (traceId) {
            window.open(getJaegerTraceUrl(traceId), '_blank');
        }
        // Mark that user has completed the journey
        localStorage.setItem('hasCompletedFirstTrade', 'true');
        localStorage.removeItem('isNewUser');
        onClose();
    };

    const handleContinue = () => {
        localStorage.setItem('hasCompletedFirstTrade', 'true');
        localStorage.removeItem('isNewUser');
        onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-lg bg-gradient-to-br from-slate-900 via-slate-900 to-emerald-950/30 border-emerald-500/30">
                <DialogHeader className="space-y-4">
                    {/* Success Animation */}
                    <div className="flex justify-center pt-4">
                        <div className="relative">
                            {/* Glow effect */}
                            <div className="absolute inset-0 bg-emerald-500/30 rounded-full blur-xl animate-pulse" />

                            {/* Icon container */}
                            <div className="relative p-5 rounded-full bg-gradient-to-br from-emerald-500 to-cyan-500 shadow-2xl shadow-emerald-500/30">
                                <CheckCircle2 className="w-10 h-10 text-white" />
                            </div>
                        </div>
                    </div>

                    <DialogTitle className="text-2xl font-bold text-center text-emerald-100">
                        {t('tradeVerified.title')}
                    </DialogTitle>

                    <DialogDescription className="text-center text-slate-300">
                        {t('tradeVerified.subtitle')}
                    </DialogDescription>
                </DialogHeader>

                {/* Trade Summary */}
                <div className="bg-slate-800/50 rounded-xl p-4 my-4 border border-slate-700/50">
                    <div className="flex items-center justify-between mb-3">
                        <span className={`px-3 py-1 rounded-full text-sm font-bold ${side === 'BUY'
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                            }`}>
                            {t(`orderHistory.side.${side.toLowerCase()}`)}
                        </span>
                        {executionTimeMs !== undefined && (
                            <span className="flex items-center gap-1 text-amber-400 text-sm">
                                <Zap className="w-4 h-4" />
                                {executionTimeMs}ms
                            </span>
                        )}
                    </div>

                    <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                            <p className="text-slate-400">{t('tradeForm.amount')}</p>
                            <p className="text-lg font-bold text-white">
                                {amount.toFixed(asset === 'BTC' ? 8 : 2)} {asset}
                            </p>
                        </div>
                        <div>
                            <p className="text-slate-400">{t('tradeForm.price')}</p>
                            <p className="text-lg font-bold text-white">
                                ${price.toLocaleString()}
                            </p>
                        </div>
                    </div>

                    {/* Trade ID */}
                    <div className="mt-3 pt-3 border-t border-slate-700/50">
                        <p className="text-slate-400 text-sm">{t('tradeVerified.traceId')}</p>
                        <code className="text-cyan-400 font-mono text-sm break-all">
                            {tradeId}
                        </code>
                    </div>
                </div>

                {/* Trace CTA - THE MAIN POINT */}
                {traceId && (
                    <div className="bg-slate-800/60 rounded-xl p-4 border border-purple-500/30">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="p-2 rounded-lg bg-purple-500/20">
                                <Eye className="w-5 h-5 text-purple-400" />
                            </div>
                            <div>
                                <h4 className="font-semibold text-purple-100">{t('tradeVerified.whyMatters')}</h4>
                                <p className="text-sm text-purple-300/70">
                                    {t('tradeVerified.viewTraceSubtitle')}
                                </p>
                            </div>
                        </div>

                        <code className="block bg-slate-800/50 rounded px-3 py-2 text-cyan-400 font-mono text-sm mb-4 break-all">
                            Trace: {traceId}
                        </code>

                        <Button
                            onClick={handleViewTrace}
                            className="w-full bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white font-bold py-5 text-lg group"
                        >
                            <Eye className="w-5 h-5 mr-2" />
                            {t('tradeVerified.viewTrace')}
                            <ExternalLink className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
                        </Button>
                    </div>
                )}

                {/* Secondary action */}
                <div className="flex gap-3 mt-2">
                    <Button
                        variant="outline"
                        onClick={handleContinue}
                        className="flex-1 border-slate-600 text-slate-300 hover:bg-slate-800"
                    >
                        <TrendingUp className="w-4 h-4 mr-2" />
                        {t('tradeVerified.tradeAgain')}
                    </Button>
                    <Button
                        variant="ghost"
                        onClick={() => {
                            handleContinue();
                            window.location.href = '/portfolio';
                        }}
                        className="flex-1 text-slate-400 hover:text-slate-300"
                    >
                        {t('tradeVerified.close')}
                        <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
