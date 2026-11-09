import React, { useState, FormEvent } from 'react';
import { clearLocalIdentity, sapSignInTarget } from '../services/authNavigation';
import { setAuthToken } from '../services/api';
import logoImg from '../assets/logo-transparent.png';
import {
  ShieldCheck,
  Eye,
  EyeOff,
  Lock,
  Mail,
  ArrowRight,
  Server,
  Cpu,
  Database,
  ExternalLink,
  AlertCircle,
  Sparkles,
  Layers,
  KeyRound
} from 'lucide-react';

export interface UserContext {
  user_id: string;
  email: string;
  name: string;
  roles: string[];
}

export interface EnterpriseSignInProps {
  onSignInSuccess?: (user: UserContext) => void;
  apiBaseUrl?: string;
  ssoRedirectUrl?: string;
}

export const EnterpriseSignIn: React.FC<EnterpriseSignInProps> = ({
  onSignInSuccess,
  apiBaseUrl = '',
  ssoRedirectUrl
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isSsoLoading, setIsSsoLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The protected AppRouter entry point starts SAP's hosted SSO flow.
  const handleSSORedirect = () => {
    setIsSsoLoading(true);
    setError(null);
    try {
      const target = ssoRedirectUrl || sapSignInTarget();
      clearLocalIdentity(false);
      window.location.assign(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'SAP sign-in could not be started.');
      setIsSsoLoading(false);
    }
  };

  // Direct Credential Auth Submission (Corporate Email & Password)
  const handleSubmit = async (e?: FormEvent, directEmail?: string, directPassword?: string) => {
    if (e?.preventDefault) e.preventDefault();
    const cleanEmail = (directEmail !== undefined ? directEmail : email).trim();
    const cleanPassword = directPassword !== undefined ? directPassword : password;
    if (!cleanEmail || !cleanPassword) {
      setError('Please provide both corporate email address and master password.');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      let userContext: UserContext | null = null;
      let token: string | null = null;

      try {
        const loginRes = await fetch(`${apiBaseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: cleanEmail, password: cleanPassword, rememberMe })
        });

        const data = await loginRes.json();

        if (loginRes.ok && data.status === 'success') {
          userContext = data.user;
          token = data.token;
        } else {
          setError(data.detail || 'Invalid corporate email or password. Access denied.');
          setIsLoading(false);
          return;
        }
      } catch {
        setError('Authentication service unreachable. Valid SAP BTP IAS token or credentials required.');
        setIsLoading(false);
        return;
      }

      if (userContext) {
        clearLocalIdentity(false);
        if (token) {
          setAuthToken(token);
          localStorage.setItem('auth_user', JSON.stringify(userContext));
        }
        if (onSignInSuccess) {
          onSignInSuccess(userContext);
        }
      } else {
        setError('Authentication failed. Invalid corporate credentials.');
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Authentication service temporarily unreachable.';
      setError(errMsg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex flex-col lg:flex-row bg-[#0B1120] text-slate-100 font-sans antialiased select-none">
      {/* Left Column: Brand & Architecture Telemetry (Dark Enterprise Theme) */}
      <div className="relative w-full lg:w-[50%] p-8 sm:p-12 lg:p-16 xl:p-20 flex flex-col justify-between overflow-hidden bg-gradient-to-br from-[#060913] via-[#0B1120] to-[#141E33] border-b lg:border-b-0 lg:border-r border-slate-800/80">
        {/* Subtle grid pattern background */}
        <div 
          className="absolute inset-0 opacity-20 pointer-events-none" 
          style={{
            backgroundImage: 'radial-gradient(rgba(148, 163, 184, 0.25) 1px, transparent 1px)',
            backgroundSize: '24px 24px'
          }}
        />

        {/* Ambient glow accent */}
        <div className="absolute top-[-100px] left-[-100px] w-96 h-96 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-[-100px] right-[-100px] w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl pointer-events-none" />

        {/* Brand Header */}
        <div className="relative z-10 flex items-center gap-4 mb-10">
          <div className="w-14 h-14 rounded-2xl bg-white/10 backdrop-blur-md border border-white/20 flex items-center justify-center p-2 shadow-md shrink-0">
            <img src={logoImg} alt="Neovatic Logo" className="w-full h-full object-contain" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-wider uppercase text-slate-100">
              NEOVATIC GEN-AI ANALYTICS PLATFORM
            </h1>
            <p className="text-xs font-medium text-slate-400 tracking-wide uppercase">
              SAP HANA CLOUD &amp; AI CORE
            </p>
          </div>
        </div>

        {/* Hero Narrative */}
        <div className="relative z-10 max-w-lg my-auto py-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold mb-6">
            <Sparkles size={13} className="text-blue-400" />
            <span>ENTERPRISE ANALYTICS &amp; RAG SERVICE</span>
          </div>

          <h2 className="text-3xl sm:text-4xl xl:text-[40px] font-extrabold tracking-tight text-white leading-[1.18] mb-5">
            Unified Data Intelligence &amp; Autonomous Vector Synthesis
          </h2>

          <p className="text-slate-300 text-sm sm:text-base leading-relaxed mb-8">
            Direct conversational queries, real-time natural language to SAP HANA SQL generation, and multi-tenant RAG exploration across enterprise business records.
          </p>

          {/* Live Federated Infrastructure Card */}
          <div className="rounded-2xl p-5 bg-slate-800/60 backdrop-blur-md border border-slate-700/60 shadow-xl space-y-3.5">
            <div className="flex items-center justify-between pb-3 border-b border-slate-700/50">
              <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
                <Layers size={14} className="text-blue-400" />
                Live Federated Infrastructure
              </span>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span>Operational</span>
              </div>
            </div>

            <div className="space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5 text-slate-200">
                  <Database size={15} className="text-blue-400" />
                  <span>SAP HANA Cloud Vector Engine</span>
                </div>
                <span className="font-mono text-[11px] font-medium px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                  CONNECTED
                </span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5 text-slate-200">
                  <Cpu size={15} className="text-emerald-400" />
                  <span>NVIDIA NIM Inference Runtime</span>
                </div>
                <span className="font-mono text-[11px] font-medium px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  ONLINE
                </span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5 text-slate-200">
                  <Server size={15} className="text-purple-400" />
                  <span>SAP AI Core &amp; XSUAA Identity</span>
                </div>
                <span className="font-mono text-[11px] font-medium px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">
                  READY
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Left Footer Telemetry */}
        <div className="relative z-10 flex flex-wrap items-center gap-3 text-xs text-slate-500 pt-6">
          <span>Tenant: eu10.hana.ondemand.com</span>
          <span>•</span>
          <span>MTA v1.0.0-PROD</span>
          <span>•</span>
          <span>Multi-Agent Mesh</span>
        </div>
      </div>

      {/* Right Column: Centered High-Contrast Auth Card */}
      <div className="w-full lg:w-[50%] bg-[#F8FAFC] text-slate-900 p-6 sm:p-12 lg:p-16 flex items-center justify-center min-h-[560px] lg:min-h-screen">
        <div className="w-full max-w-[420px] space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xl shadow-slate-200/50 p-7 sm:p-9 space-y-6">
            <div>
              <div className="flex items-center gap-3.5 mb-5">
                <div className="w-13 h-13 rounded-2xl bg-slate-50 border border-slate-200/90 flex items-center justify-center p-1.5 shadow-xs shrink-0">
                  <img src={logoImg} alt="Neovatic Logo" className="w-full h-full object-contain" />
                </div>
                <div>
                  <span className="font-bold text-sm text-slate-900 tracking-tight block">NEOVATIC GEN-AI</span>
                  <span className="text-[11px] text-slate-500 font-mono uppercase block">SAP HANA & AI CORE</span>
                </div>
              </div>
              <h2 className="text-2xl font-bold tracking-tight text-slate-900">Enterprise Sign In</h2>
              <p className="text-xs sm:text-sm text-slate-500 mt-1.5">
                Authenticate with your corporate credentials to access tenant analytics.
              </p>
            </div>

            {error && (
              <div className="flex items-start gap-2.5 p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-medium" role="alert">
                <AlertCircle size={16} className="shrink-0 mt-0.5 text-red-600" />
                <div className="flex-1">{error}</div>
              </div>
            )}

            {/* Primary SSO Button */}
            <button
              type="button"
              onClick={handleSSORedirect}
              disabled={isSsoLoading || isLoading}
              className="w-full flex items-center justify-center gap-2.5 py-3 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 active:scale-[0.99] text-white font-semibold text-xs sm:text-sm shadow-sm transition-all cursor-pointer disabled:opacity-50"
            >
              {isSsoLoading ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <KeyRound size={16} />
                  <span>Sign in with SAP Universal ID / BTP IAS</span>
                  <ArrowRight size={14} className="ml-0.5" />
                </>
              )}
            </button>

            {/* Clean Divider */}
            <div className="relative flex items-center justify-center">
              <div className="w-full border-t border-slate-200" />
              <span className="absolute bg-white px-3 text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                or continue with corporate email
              </span>
            </div>

            {/* Direct Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5" htmlFor="corporate-email">
                  Corporate Email Address
                </label>
                <div className="relative">
                  <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    id="corporate-email"
                    type="email"
                    placeholder="name@enterprise.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="username"
                    className="w-full h-10 pl-10 pr-3.5 rounded-xl border border-slate-300 bg-white text-slate-900 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5" htmlFor="corporate-password">
                  Enterprise Password
                </label>
                <div className="relative">
                  <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    id="corporate-password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="••••••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    className="w-full h-10 pl-10 pr-10 rounded-xl border border-slate-300 bg-white text-slate-900 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs text-slate-500 pt-0.5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500/20"
                  />
                  <span>Remember session (12 hrs)</span>
                </label>
                <a href="#need-help" className="text-blue-600 hover:text-blue-700 font-medium">
                  Forgot password?
                </a>
              </div>

              <button
                type="submit"
                disabled={isLoading || isSsoLoading}
                className="w-full flex items-center justify-center gap-2 h-11 rounded-xl bg-blue-600 hover:bg-blue-700 active:scale-[0.99] text-white font-semibold text-sm shadow-sm transition-all cursor-pointer disabled:opacity-50"
              >
                {isLoading ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <>
                    <span>Direct Enterprise Authenticate</span>
                    <ArrowRight size={15} />
                  </>
                )}
              </button>
            </form>
          </div>

          {/* Footer Security Badges */}
          <div className="text-center space-y-2.5">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-100 border border-slate-200 text-[11px] text-slate-600 font-medium">
              <ShieldCheck size={13} className="text-emerald-600" />
              <span>Protected by SAP Authorization &amp; Trust Management (XSUAA) • 256-Bit SSL</span>
            </div>
            <div className="flex items-center justify-center gap-3 text-xs text-slate-400">
              <a href="#access-help" className="hover:text-slate-600 transition-colors">Need access help?</a>
              <span>•</span>
              <a href="/api/health" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-slate-600 transition-colors">
                System Health (/api/health)
                <ExternalLink size={11} />
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EnterpriseSignIn;
