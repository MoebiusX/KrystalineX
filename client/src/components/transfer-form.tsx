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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight, Loader2, Send, Bitcoin, Users } from "lucide-react";

// Type-safe error message extraction
const getErrorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : 'An error occurred';

const transferSchema = z.object({
    // Support both wallet address (kx1...) and legacy userId
    toAddress: z.string().min(1, "Enter recipient wallet address"),
    toUserId: z.string().optional(),  // Legacy, derived from address
    asset: z.string().default("BTC"),
    amount: z.number().positive().max(10000000),
});

type TransferFormData = z.infer<typeof transferSchema>;

interface User {
    id: string;
    name: string;
    email?: string;
    avatar?: string;
    walletAddress?: string;  // Krystaline address (kx1...)
}

// Helper to format wallet address for display
function formatAddress(address: string): string {
    if (!address || address.length < 12) return address;
    return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

// Check if string is a valid Krystaline address
function isKXAddress(str: string): boolean {
    return str?.startsWith('kx1') && str.length >= 20;
}

export function TransferForm() {
    const { toast } = useToast();
    const queryClient = useQueryClient();

    // Get current user from localStorage
    const [currentUser, setCurrentUser] = useState<{ id: string; email: string; walletAddress?: string } | null>(null);

    useEffect(() => {
        const userData = localStorage.getItem('user');
        if (userData) {
            try {
                setCurrentUser(JSON.parse(userData));
            } catch { }
        }
    }, []);

    // Fetch all verified users
    const { data: users, isLoading: usersLoading } = useQuery<User[]>({
        queryKey: ["/api/v1/users"],
        enabled: !!currentUser,
    });

    // Only show seed users as transfer recipients (exclude current user)
    const ALLOWED_RECIPIENTS = ['seed.user.primary@krystaline.io', 'seed.user.secondary@krystaline.io'];
    const availableRecipients = users?.filter(u =>
        u.id !== currentUser?.id && ALLOWED_RECIPIENTS.includes(u.email || '')
    ) || [];

    const form = useForm<TransferFormData>({
        resolver: zodResolver(transferSchema),
        defaultValues: {
            toAddress: "",
            toUserId: "",
            asset: "BTC",
            amount: 0.01,
        },
    });

    const transferMutation = useMutation({
        mutationFn: async (data: TransferFormData) => {
            const tracer = trace.getTracer('kx-wallet');
            const token = localStorage.getItem('accessToken');

            return tracer.startActiveSpan('transfer.submit.client', async (parentSpan) => {
                const parentContext = context.active();

                try {
                    parentSpan.setAttribute('transfer.toAddress', data.toAddress);
                    parentSpan.setAttribute('transfer.amount', data.amount);
                    parentSpan.setAttribute('transfer.asset', data.asset);

                    const response = await fetch('/api/v1/wallet/transfer', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`,
                        },
                        body: JSON.stringify({
                            toAddress: data.toAddress,
                            toUserId: data.toUserId,  // Legacy fallback
                            asset: data.asset,
                            amount: data.amount,
                        }),
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
                        throw new Error(result.error || 'Transfer failed');
                    }

                    context.with(trace.setSpan(parentContext, parentSpan), () => {
                        const responseSpan = tracer.startSpan('transfer.response.received');
                        responseSpan.setAttribute('transfer.id', result.transferId || 'unknown');
                        responseSpan.setAttribute('transfer.success', result.success);
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
            const recipient = availableRecipients.find(u =>
                u.walletAddress === form.getValues('toAddress') || u.id === form.getValues('toUserId')
            );

            toast({
                title: "Transfer Complete! ✓",
                description: (
                    <div className="space-y-1 text-sm">
                        <p className="font-mono">
                            Sent {form.getValues('amount')} {form.getValues('asset')} to {recipient?.name}
                        </p>
                        <p className="text-xs text-slate-400">
                            New balance: {data.fromBalance} {form.getValues('asset')}
                        </p>
                        <p className="text-xs text-slate-400">
                            Transfer ID: {data.transferId}
                        </p>
                    </div>
                ),
            });

            // Refresh data
            queryClient.invalidateQueries({ queryKey: ["/api/v1/wallet"] });
            queryClient.invalidateQueries({ queryKey: ["/api/v1/wallet/balances"] });
            queryClient.invalidateQueries({ queryKey: ["/api/v1/transfers"] });

            // Reset form
            form.reset({ toUserId: "", asset: "BTC", amount: 0.01 });
        },
        onError: (error) => {
            toast({
                title: "Transfer Failed",
                description: error.message,
                variant: "destructive",
            });
        },
    });

    const onSubmit = (data: TransferFormData) => {
        transferMutation.mutate(data);
    };

    // Find recipient by address or userId
    const selectedRecipient = availableRecipients.find(u =>
        u.walletAddress === form.watch('toAddress') || u.id === form.watch('toUserId')
    );

    // Handle recipient selection - set both address and userId
    const handleRecipientSelect = (userId: string) => {
        const recipient = availableRecipients.find(u => u.id === userId);
        if (recipient) {
            form.setValue('toUserId', userId);
            form.setValue('toAddress', recipient.walletAddress || userId);
        }
    };

    if (!currentUser) {
        return (
            <Card className="w-full bg-slate-900 border-slate-700 text-white">
                <CardContent className="py-8 text-center">
                    <p className="text-slate-400">Please log in to make transfers</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className="w-full bg-slate-900 border-slate-700 text-white">
            <CardHeader className="pb-4">
                <CardTitle className="text-lg font-bold flex items-center gap-2">
                    <Send className="w-5 h-5 text-purple-400" />
                    Transfer Crypto
                </CardTitle>
                {currentUser.walletAddress && (
                    <p className="text-xs text-slate-400 font-mono mt-1">
                        Your wallet: {formatAddress(currentUser.walletAddress)}
                    </p>
                )}
            </CardHeader>

            <CardContent className="space-y-5">
                {/* Transfer Direction */}
                <div className="flex items-center justify-center gap-4 p-4 bg-slate-800 rounded-lg">
                    <div className="text-center">
                        <div className="text-3xl mb-1">👤</div>
                        <div className="text-sm font-medium">{currentUser.email?.split('@')[0]}</div>
                        <div className="text-xs text-slate-400 font-mono">
                            {currentUser.walletAddress ? formatAddress(currentUser.walletAddress) : 'You'}
                        </div>
                    </div>
                    <ArrowRight className="w-8 h-8 text-purple-400" />
                    <div className="text-center">
                        <div className="text-3xl mb-1">{selectedRecipient?.avatar || '❓'}</div>
                        <div className="text-sm font-medium">{selectedRecipient?.name || 'Select recipient'}</div>
                        <div className="text-xs text-slate-400 font-mono">
                            {selectedRecipient?.walletAddress ? formatAddress(selectedRecipient.walletAddress) : 'Recipient'}
                        </div>
                    </div>
                </div>

                {/* No other users message */}
                {!usersLoading && availableRecipients.length === 0 && (
                    <div className="p-6 bg-gradient-to-br from-amber-900/20 to-orange-900/20 border border-amber-500/30 rounded-xl text-center">
                        <div className="relative inline-block mb-3">
                            <Users className="w-10 h-10 text-amber-400/60" />
                        </div>
                        <h4 className="text-amber-200 font-medium mb-1">No Recipients Available</h4>
                        <p className="text-amber-200/60 text-sm max-w-xs mx-auto">
                            P2P transfers require other registered users. Create another account in a different browser to test this feature.
                        </p>
                    </div>
                )}

                {/* Transfer Form */}
                {availableRecipients.length > 0 && (
                    <Form {...form}>
                        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                            {/* Wallet Address Input */}
                            <FormField
                                control={form.control}
                                name="toAddress"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-slate-300 flex items-center gap-2">
                                            <Send className="w-4 h-4 text-purple-400" />
                                            Recipient Wallet Address
                                        </FormLabel>
                                        <FormControl>
                                            <Input
                                                {...field}
                                                placeholder="kx1... or select from known recipients"
                                                className="bg-slate-800 border-slate-600 text-white font-mono text-sm h-12"
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            {/* Quick Select Known Recipients */}
                            <FormField
                                control={form.control}
                                name="toUserId"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-slate-300 flex items-center gap-2">
                                            <Users className="w-4 h-4 text-purple-400" />
                                            Or Select Known Recipient
                                        </FormLabel>
                                        <Select onValueChange={handleRecipientSelect} value={field.value}>
                                            <FormControl>
                                                <SelectTrigger className="bg-slate-800 border-slate-600 text-white h-12">
                                                    <SelectValue placeholder="Select recipient..." />
                                                </SelectTrigger>
                                            </FormControl>
                                            <SelectContent className="bg-slate-800 border-slate-600">
                                                {availableRecipients.map((user) => (
                                                    <SelectItem
                                                        key={user.id}
                                                        value={user.id}
                                                        className="text-white hover:bg-slate-700"
                                                    >
                                                        {user.avatar || '👤'} {user.name}
                                                        {user.walletAddress && (
                                                            <span className="text-slate-400 font-mono text-xs ml-2">
                                                                {formatAddress(user.walletAddress)}
                                                            </span>
                                                        )}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            {/* Amount */}
                            <FormField
                                control={form.control}
                                name="amount"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel className="text-slate-300 flex items-center gap-2">
                                            <Bitcoin className="w-4 h-4 text-orange-400" />
                                            Amount (BTC)
                                        </FormLabel>
                                        <FormControl>
                                            <Input
                                                type="number"
                                                step="0.001"
                                                min="0.001"
                                                max="10000000"
                                                placeholder="0.1"
                                                {...field}
                                                onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                                                className="bg-slate-800 border-slate-600 text-white font-mono text-lg h-12"
                                            />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />

                            <Button
                                type="submit"
                                disabled={transferMutation.isPending || !form.watch('toUserId')}
                                className="w-full h-14 text-lg font-bold bg-purple-600 hover:bg-purple-700"
                            >
                                {transferMutation.isPending ? (
                                    <>
                                        <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                                        Sending...
                                    </>
                                ) : (
                                    <>
                                        <Send className="w-5 h-5 mr-2" />
                                        Send {(form.watch("amount") ?? 0).toFixed(4)} BTC
                                        {selectedRecipient && ` to ${selectedRecipient.name}`}
                                    </>
                                )}
                            </Button>
                        </form>
                    </Form>
                )}
            </CardContent>
        </Card>
    );
}
