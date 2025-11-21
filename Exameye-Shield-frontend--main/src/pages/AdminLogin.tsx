import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shield, Lock, ArrowLeft, UserPlus, LogIn, ShieldCheck, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

const AdminLogin = () => {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [azureLoading, setAzureLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const handleSuccessfulAuth = useCallback(
    (session: any) => {
      if (!session) return;
      const adminName =
        session.user?.user_metadata?.name ||
        session.user?.user_metadata?.full_name ||
        session.user?.email ||
        "Admin";
      sessionStorage.setItem("adminAuth", "true");
      sessionStorage.setItem("adminName", adminName);
      sessionStorage.removeItem("adminOAuthPending");
      setAzureLoading(false);
      setLoading(false);
      toast.success(`Welcome back, ${adminName}!`);
      navigate("/admin/dashboard", { replace: true });
    },
    [navigate]
  );

  useEffect(() => {
    if (sessionStorage.getItem("adminAuth") === "true") {
      navigate("/admin/dashboard", { replace: true });
      return;
    }

    let authSubscription: { unsubscribe: () => void } | null = null;

    const initializeSession = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session) {
        handleSuccessfulAuth(session);
      }

      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        if (session) {
          handleSuccessfulAuth(session);
        } else {
          sessionStorage.removeItem("adminAuth");
          sessionStorage.removeItem("adminName");
        }
      });

      authSubscription = data.subscription;
    };

    initializeSession();

    return () => {
      authSubscription?.unsubscribe();
    };
  }, [handleSuccessfulAuth]);

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email || !password) {
      toast.error("Please provide email and password");
      return;
    }

    if (mode === "signup" && !fullName.trim()) {
      toast.error("Please enter the admin name");
      return;
    }

    if (mode === "signup" && password !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }

    setLoading(true);

    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              role: "admin",
              name: fullName.trim(),
            },
          },
        });

        if (error) {
          throw error;
        }

        toast.success("Registration successful!");
        setMode("signin");
        setPassword("");
        setConfirmPassword("");
        setFullName("");
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (error) {
          throw error;
        }

        handleSuccessfulAuth(data.session);
      }
    } catch (error: any) {
      toast.error(error.message || "Authentication failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleAzureLogin = async () => {
    setAzureLoading(true);
    try {
      sessionStorage.setItem("adminOAuthPending", "true");
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "azure",
        options: {
          redirectTo: `${window.location.origin}/admin/login`,
          scopes: "openid profile email",
          queryParams: {
            prompt: "login",
          },
        },
      });

      if (error) {
        throw error;
      }

      toast.info("Redirecting to Microsoft for secure login...");
    } catch (error: any) {
      setAzureLoading(false);
      toast.error(error.message || "Azure login failed. Please try again.");
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-8 flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/')}
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center">
              <Shield className="w-7 h-7 text-secondary-foreground" />
            </div>
            <div>
              <h1 className="text-lg font-bold">ExamEye Shield</h1>
              <p className="text-sm text-muted-foreground">Admin Access</p>
            </div>
          </div>
        </div>

        {/* Login Form */}
        <Card>
          <CardContent className="p-8">
            <div className="w-16 h-16 rounded-full bg-secondary/10 flex items-center justify-center mx-auto mb-6">
              <Lock className="w-8 h-8 text-secondary" />
            </div>

            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold mb-2">Secure Admin Access</h2>
              <p className="text-sm text-muted-foreground">
                Sign in or create an admin account, or continue with Microsoft Azure SSO.
              </p>
            </div>

            <div className="flex items-center gap-2 mb-6">
              <Button
                type="button"
                variant={mode === "signin" ? "default" : "outline"}
                className="flex-1"
                onClick={() => setMode("signin")}
              >
                <LogIn className="w-4 h-4 mr-2" />
                Sign In
              </Button>
              <Button
                type="button"
                variant={mode === "signup" ? "default" : "outline"}
                className="flex-1"
                onClick={() => setMode("signup")}
              >
                <UserPlus className="w-4 h-4 mr-2" />
                Sign Up
              </Button>
            </div>

            <form onSubmit={handleEmailAuth} className="space-y-6">
              {mode === "signup" && (
                <div className="space-y-2">
                  <Label htmlFor="fullName">Admin Name</Label>
                  <Input
                    id="fullName"
                    type="text"
                  placeholder="Enter admin name"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    required
                  />
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="admin@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="pr-10"
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground"
                    onClick={() => setShowPassword(prev => !prev)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {mode === "signup" && (
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm Password</Label>
                  <div className="relative">
                    <Input
                      id="confirmPassword"
                      type={showConfirmPassword ? "text" : "password"}
                      placeholder="••••••••"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      className="pr-10"
                    />
                    <button
                      type="button"
                      className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground"
                      onClick={() => setShowConfirmPassword(prev => !prev)}
                      aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                    >
                      {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              )}

              <Button 
                type="submit" 
                className="w-full bg-secondary hover:bg-secondary/90" 
                size="lg"
                disabled={loading}
              >
                {loading
                  ? mode === "signup"
                    ? "Creating admin..."
                    : "Signing in..."
                  : mode === "signup"
                  ? "Create Admin Account"
                  : "Access Dashboard"}
              </Button>
            </form>

            <div className="my-6 flex items-center gap-2">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                or continue with
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <Button
              variant="outline"
              className="w-full flex items-center justify-center gap-2"
              size="lg"
              onClick={handleAzureLogin}
              disabled={azureLoading}
            >
              <ShieldCheck className="w-4 h-4" />
              {azureLoading ? "Redirecting..." : "Sign in with Microsoft Azure"}
            </Button>
          </CardContent>
        </Card>

        {/* Security Info */}
        <Card className="mt-6 bg-secondary/5 border-secondary/20">
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-3">
              <Lock className="w-5 h-5 text-secondary" />
              <h3 className="font-semibold">Secure Access</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Admin access is protected by Supabase authentication and Azure OAuth. All activities are logged for security.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default AdminLogin;
