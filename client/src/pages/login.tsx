import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { createLogger } from "@/lib/logger";

const log = createLogger('Login');
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Shield, ArrowLeft } from "lucide-react";

export default function Login() {
    const [, setLocation] = useLocation();
    const { t } = useTranslation('auth');
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");

    // 2FA state
    const [requires2FA, setRequires2FA] = useState(false);
    const [tempToken, setTempToken] = useState("");
    const [totpCode, setTotpCode] = useState("");

    const loginMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch("/api/v1/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password }),
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "Login failed");
            }
            return res.json();
        },
        onSuccess: (data) => {
            if (data.requires2FA) {
                // User has 2FA enabled - show TOTP input
                setRequires2FA(true);
                setTempToken(data.tempToken);
                setError("");
            } else {
                log.info({ userId: data.user?.id, idType: typeof data.user?.id }, 'Login successful');

                // Normal login - store tokens and redirect
                localStorage.setItem("accessToken", data.tokens.accessToken);
                localStorage.setItem("refreshToken", data.tokens.refreshToken);
                localStorage.setItem("user", JSON.stringify(data.user));
                setLocation("/portfolio");
            }
        },
        onError: (err: Error) => {
            setError(err.message);
        },
    });

    // 2FA verification mutation
    const verify2FAMutation = useMutation({
        mutationFn: async () => {
            const res = await fetch("/api/v1/auth/2fa/login-verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tempToken, code: totpCode }),
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "Verification failed");
            }
            return res.json();
        },
        onSuccess: (data) => {
            // Store tokens and redirect
            localStorage.setItem("accessToken", data.tokens.accessToken);
            localStorage.setItem("refreshToken", data.tokens.refreshToken);
            localStorage.setItem("user", JSON.stringify(data.user));
            setLocation("/portfolio");
        },
        onError: (err: Error) => {
            setError(err.message);
        },
    });

    const handleLogin = (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        loginMutation.mutate();
    };

    const handle2FAVerify = (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        verify2FAMutation.mutate();
    };

    const handleBackToLogin = () => {
        setRequires2FA(false);
        setTempToken("");
        setTotpCode("");
        setPassword("");
        setError("");
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-950 via-blue-950 to-slate-900 flex items-center justify-center p-4">
            {/* Back to Home */}
            <a href="/" className="absolute top-6 left-6 flex items-center gap-2 text-cyan-100/70 hover:text-cyan-100 transition-colors group">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="group-hover:-translate-x-1 transition-transform"><path d="m15 18-6-6 6-6" /></svg>
                <span className="text-sm font-medium">{t('login.backToHome')}</span>
            </a>

            <Card className="w-full max-w-md bg-slate-900/80 border-cyan-500/20 backdrop-blur-xl shadow-2xl">
                {!requires2FA ? (
                    // Normal login form
                    <>
                        <CardHeader className="text-center">
                            <CardTitle className="text-3xl font-bold bg-gradient-to-r from-cyan-400 via-blue-400 to-indigo-400 bg-clip-text text-transparent">
                                {t('login.title')}
                            </CardTitle>
                            <CardDescription className="text-cyan-100/60">
                                {t('login.subtitle')}
                            </CardDescription>
                        </CardHeader>

                        <CardContent>
                            {error && (
                                <Alert variant="destructive" className="mb-4">
                                    <AlertDescription>{error}</AlertDescription>
                                </Alert>
                            )}

                            <form onSubmit={handleLogin} className="space-y-4">
                                <div className="space-y-2">
                                    <Label htmlFor="email" className="text-cyan-100">{t('login.email')}</Label>
                                    <Input
                                        id="email"
                                        type="email"
                                        placeholder={t('login.emailPlaceholder')}
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        required
                                        className="bg-slate-800/50 border-cyan-500/30 text-cyan-100 placeholder:text-cyan-100/30"
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="password" className="text-cyan-100">{t('login.password')}</Label>
                                    <Input
                                        id="password"
                                        type="password"
                                        placeholder={t('login.passwordPlaceholder')}
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        required
                                        className="bg-slate-800/50 border-cyan-500/30 text-cyan-100 placeholder:text-cyan-100/30"
                                    />
                                </div>

                                <Button
                                    type="submit"
                                    className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 shadow-lg shadow-cyan-500/25"
                                    disabled={loginMutation.isPending}
                                >
                                    {loginMutation.isPending ? t('login.submitting') : t('login.submit')}
                                </Button>
                            </form>
                        </CardContent>

                        <CardFooter className="flex flex-col gap-2">
                            <div className="text-sm text-slate-400">
                                {t('login.noAccount')}{" "}
                                <a href="/register" className="text-purple-400 hover:underline">
                                    {t('login.createAccount')}
                                </a>
                            </div>
                        </CardFooter>
                    </>
                ) : (
                    // 2FA verification form
                    <>
                        <CardHeader className="text-center">
                            <div className="mx-auto mb-4 w-16 h-16 rounded-full bg-gradient-to-br from-cyan-500/20 to-blue-500/20 flex items-center justify-center">
                                <Shield className="w-8 h-8 text-cyan-400" />
                            </div>
                            <CardTitle className="text-2xl font-bold text-cyan-100">
                                {t('twoFactor.title')}
                            </CardTitle>
                            <CardDescription className="text-cyan-100/60">
                                {t('twoFactor.subtitle')}
                            </CardDescription>
                        </CardHeader>

                        <CardContent>
                            {error && (
                                <Alert variant="destructive" className="mb-4">
                                    <AlertDescription>{error}</AlertDescription>
                                </Alert>
                            )}

                            <form onSubmit={handle2FAVerify} className="space-y-6">
                                <div className="space-y-2">
                                    <Label htmlFor="totp" className="text-cyan-100">{t('twoFactor.codeLabel')}</Label>
                                    <Input
                                        id="totp"
                                        type="text"
                                        inputMode="numeric"
                                        placeholder={t('twoFactor.codePlaceholder')}
                                        value={totpCode}
                                        onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                        required
                                        maxLength={6}
                                        className="bg-slate-800/50 border-cyan-500/30 text-cyan-100 placeholder:text-cyan-100/30 text-center text-2xl font-mono tracking-[0.5em]"
                                        autoFocus
                                    />
                                    <p className="text-xs text-cyan-100/50 text-center mt-2">
                                        {t('twoFactor.codeHint')}
                                    </p>
                                </div>

                                <Button
                                    type="submit"
                                    className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 shadow-lg shadow-cyan-500/25"
                                    disabled={verify2FAMutation.isPending || totpCode.length !== 6}
                                >
                                    {verify2FAMutation.isPending ? t('twoFactor.verifying') : t('twoFactor.verify')}
                                </Button>
                            </form>
                        </CardContent>

                        <CardFooter className="flex flex-col gap-2">
                            <Button
                                variant="ghost"
                                onClick={handleBackToLogin}
                                className="text-cyan-100/60 hover:text-cyan-100"
                            >
                                <ArrowLeft className="w-4 h-4 mr-2" />
                                {t('twoFactor.backToLogin')}
                            </Button>
                        </CardFooter>
                    </>
                )}
            </Card>
        </div>
    );
}
