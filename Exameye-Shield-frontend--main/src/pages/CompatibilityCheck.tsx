import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import {
  CheckCircle2,
  Monitor,
  Network,
  Share2,
  Mic,
  Sun,
  ShieldCheck,
  Loader2,
  Lock,
} from "lucide-react";

type StepStatus = "idle" | "running" | "success" | "error";

interface StepState {
  status: StepStatus;
  message?: string;
  value?: number | string | boolean;
}

const MIN_SCREEN_WIDTH = 1280;
const MIN_SCREEN_HEIGHT = 720;
const MIN_SPEED_Mbps = 2;

type SpeechRecognitionEventLike = Event & {
  results?: {
    [index: number]: {
      [index: number]: {
        transcript?: string;
      };
    };
  };
};

const MIN_AUDIO_BASELINE = 10;
const normalizeText = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const wordMatchRatio = (required: string, spoken: string) => {
  if (!required || !spoken) return 0;
  const requiredWords = required.split(" ").filter(Boolean);
  const spokenWords = new Set(spoken.split(" ").filter(Boolean));
  if (requiredWords.length === 0) return 0;
  const matches = requiredWords.filter((word) => spokenWords.has(word)).length;
  return matches / requiredWords.length;
};

const CompatibilityCheck = () => {
  const navigate = useNavigate();
  const [studentData, setStudentData] = useState<any>(null);
  const [systemInfo, setSystemInfo] = useState<StepState>({ status: "idle" });
  const [networkTest, setNetworkTest] = useState<StepState>({ status: "idle" });
  const [screenShare, setScreenShare] = useState<StepState>({ status: "idle" });
  const [audioCalibration, setAudioCalibration] = useState<StepState>({ status: "idle" });
  const [lightingCheck, setLightingCheck] = useState<StepState>({ status: "idle" });
  const [singleTabCheck, setSingleTabCheck] = useState<StepState>({ status: "idle" });
  const [resumeSentence, setResumeSentence] = useState("I confirm that I will follow all exam rules.");
  const lightingVideoRef = useRef<HTMLVideoElement>(null);
  const calibrationStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const tabCheckChannelRef = useRef<BroadcastChannel | null>(null);
  const tabCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const data = sessionStorage.getItem("studentData");
    if (!data) {
      toast.error("Please register first");
      navigate("/student/register");
      return;
    }
    setStudentData(JSON.parse(data));
  }, [navigate]);

  // Cleanup BroadcastChannel on unmount
  useEffect(() => {
    return () => {
      if (tabCheckChannelRef.current) {
        // Call cleanup if it exists
        if ((tabCheckChannelRef.current as any).cleanup) {
          (tabCheckChannelRef.current as any).cleanup();
        } else {
          tabCheckChannelRef.current.close();
        }
        tabCheckChannelRef.current = null;
      }
      if (tabCheckIntervalRef.current) {
        clearInterval(tabCheckIntervalRef.current);
        tabCheckIntervalRef.current = null;
      }
    };
  }, []);

  const detectBrowser = useCallback(() => {
    const ua = window.navigator.userAgent.toLowerCase();
    if (ua.includes("chrome") && !ua.includes("edg") && !ua.includes("opr")) {
      return { name: "Chrome", isChrome: true };
    } else if (ua.includes("edg")) {
      return { name: "Microsoft Edge", isChrome: false };
    } else if (ua.includes("firefox")) {
      return { name: "Firefox", isChrome: false };
    } else if (ua.includes("safari") && !ua.includes("chrome")) {
      return { name: "Safari", isChrome: false };
    } else if (ua.includes("opr")) {
      return { name: "Opera", isChrome: false };
    }
    return { name: "Unknown", isChrome: false };
  }, []);

  const checkSystemInfo = useCallback(() => {
    const resolution = `${window.screen.width} x ${window.screen.height}`;
    const browser = detectBrowser();
    const meetsResolution =
      window.screen.width >= MIN_SCREEN_WIDTH && window.screen.height >= MIN_SCREEN_HEIGHT;
    
    // Both resolution AND browser must pass
    const allPassed = meetsResolution && browser.isChrome;
    
    let message = "";
    if (!browser.isChrome) {
      message = `Browser: ${browser.name} detected. Please use Google Chrome to proceed.`;
    } else if (!meetsResolution) {
      message = `Resolution too low. Minimum: ${MIN_SCREEN_WIDTH}x${MIN_SCREEN_HEIGHT}. Current: ${resolution}`;
    } else {
      message = `Chrome detected ✓ | Resolution OK (${resolution})`;
    }
    
    setSystemInfo({
      status: allPassed ? "success" : "error",
      message,
      value: `${browser.name} | ${resolution}`,
    });
  }, [detectBrowser]);

  useEffect(() => {
    checkSystemInfo();
    
    // Listen for window resize to update resolution in real-time
    const handleResize = () => {
      checkSystemInfo();
    };
    
    window.addEventListener("resize", handleResize);
    
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [checkSystemInfo]);

  const runSpeedTest = useCallback(async () => {
    try {
      setNetworkTest({ status: "running", message: "Measuring..." });
      const TEST_RUNS = 3;
      const DOWNLOAD_BYTES = 1_000_000; // 1 MB
      const downloadChunk = async (run: number) => {
        const url = `https://speed.cloudflare.com/__down?bytes=${DOWNLOAD_BYTES}&cacheBust=${Date.now()}-${run}`;
        const start = performance.now();
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`Speed test HTTP ${response.status}`);
        await response.arrayBuffer();
        const end = performance.now();
        const seconds = (end - start) / 1000;
        return (DOWNLOAD_BYTES * 8) / seconds / 1_000_000;
      };

      const speeds: number[] = [];
      for (let i = 0; i < TEST_RUNS; i++) {
        const speed = await downloadChunk(i);
        speeds.push(speed);
        setNetworkTest({
          status: "running",
          value: speed,
          message: `Run ${i + 1}/${TEST_RUNS}: ${speed.toFixed(2)} Mbps`,
        });
      }

      const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
      const passed = avg >= MIN_SPEED_Mbps;
      setNetworkTest({
        status: passed ? "success" : "error",
        value: avg,
        message: passed
          ? `Average speed ${avg.toFixed(2)} Mbps`
          : `Average speed ${avg.toFixed(2)} Mbps < ${MIN_SPEED_Mbps} Mbps requirement`,
      });
    } catch (error) {
      console.error("Speed test failed:", error);
      setNetworkTest({
        status: "error",
        message: "Unable to measure speed. Check your connection and try again.",
      });
    }
  }, []);

  const checkScreenSharing = useCallback(async () => {
    try {
      setScreenShare({ status: "running" });
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenStreamRef.current = stream;
      setScreenShare({ status: "success", message: "Screen sharing enabled", value: true });
    } catch (error: any) {
      console.error("Screen share error:", error);
      const denied = error?.name === "NotAllowedError";
      setScreenShare({
        status: "error",
        message: denied
          ? "Screen sharing permission denied. Please click the lock icon in your browser bar and allow screen recording."
          : "Unable to start screen sharing. Please try again.",
      });
      toast.error(
        denied
          ? "Screen sharing permission is required. Please allow access and try again."
          : "Screen share failed. Please try again."
      );
    } finally {
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
    }
  }, []);

  const runAudioCalibration = useCallback(async () => {
    try {
      setAudioCalibration({ status: "running" });
      const SpeechRecognitionConstructor =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SpeechRecognitionConstructor) {
        setAudioCalibration({
          status: "error",
          message: "Speech recognition is not supported in this browser. Please use the latest Chrome or Edge.",
        });
        return;
      }

      const speechPromise = new Promise<string | null>((resolve) => {
        const recognition = new SpeechRecognitionConstructor();
        recognition.lang = "en-US";
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;
        let settled = false;
        recognition.onresult = (event: SpeechRecognitionEventLike) => {
          if (settled) return;
          settled = true;
          resolve(event.results?.[0]?.[0]?.transcript ?? "");
        };
        recognition.onerror = () => {
          if (settled) return;
          settled = true;
          resolve(null);
        };
        recognition.onend = () => {
          if (!settled) resolve(null);
        };
        recognition.start();
        setTimeout(() => {
          if (!settled) {
            recognition.stop();
          }
        }, 4000);
      });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      calibrationStreamRef.current = stream;
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      analyser.fftSize = 256;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      const samples: number[] = [];
      const durationMs = 3000;
      const start = performance.now();

      while (performance.now() - start < durationMs) {
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / bufferLength;
        samples.push(average);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const normalized = Math.min(
        Math.round(((samples.reduce((a, b) => a + b, 0) / samples.length) / 255) * 100),
        100,
      );

      const transcript = await speechPromise;
      const requiredSentence = normalizeText(resumeSentence);
      const spokenSentence = normalizeText(transcript || "");
      const sentenceMatched =
        requiredSentence.length > 0 &&
        spokenSentence.length > 0 &&
        (spokenSentence.includes(requiredSentence) || wordMatchRatio(requiredSentence, spokenSentence) >= 0.75);

      if (normalized < MIN_AUDIO_BASELINE) {
        setAudioCalibration({
          status: "error",
          message: "We couldn't detect any speech. Please read the sentence aloud and try again.",
          value: normalized,
        });
      } else if (!sentenceMatched) {
        setAudioCalibration({
          status: "error",
          message: "We could not confirm the sentence. Please read it exactly as shown and retry.",
          value: normalized,
        });
      } else {
        setAudioCalibration({
          status: "success",
          message: `Baseline audio level: ${normalized}%`,
          value: normalized,
        });
        sessionStorage.setItem("audioBaseline", String(normalized));
      }
      await audioContext.close();
    } catch (error) {
      console.error("Audio calibration failed:", error);
      setAudioCalibration({
        status: "error",
        message: "Microphone permission denied. Please allow microphone access.",
      });
    } finally {
      calibrationStreamRef.current?.getTracks().forEach((track) => track.stop());
      calibrationStreamRef.current = null;
    }
  }, []);

  const runLightingCheck = useCallback(async () => {
    try {
      setLightingCheck({ status: "running" });
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false,
      });

      if (lightingVideoRef.current) {
        lightingVideoRef.current.srcObject = stream;
        await lightingVideoRef.current.play();
      }

      await new Promise((resolve) => setTimeout(resolve, 800));

      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext("2d");
      if (!ctx || !lightingVideoRef.current) throw new Error("Lighting context missing");
      ctx.drawImage(lightingVideoRef.current, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let brightness = 0;
      for (let i = 0; i < data.length; i += 4) {
        brightness += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      }
      const avgBrightness = brightness / (data.length / 4);
      const score = Math.round((avgBrightness / 255) * 100);
      const goodLighting = score >= 35 && score <= 90;
      setLightingCheck({
        status: goodLighting ? "success" : "error",
        message: goodLighting
          ? `Lighting OK (${score}%)`
          : `Lighting too ${score < 35 ? "dark" : "bright"} (${score}%). Adjust your environment.`,
        value: score,
      });
      sessionStorage.setItem("lightingScore", String(score));
      stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      console.error("Lighting check failed:", error);
      setLightingCheck({
        status: "error",
        message: "Unable to access camera for lighting check.",
      });
    }
  }, []);

  const checkSingleTab = useCallback(() => {
    try {
      setSingleTabCheck({ status: "running", message: "Checking for multiple tabs..." });
      
      // Check if BroadcastChannel is supported
      if (typeof BroadcastChannel === 'undefined') {
        setSingleTabCheck({
          status: "error",
          message: "Single tab detection not supported in this browser. Please use Chrome or Edge.",
        });
        return;
      }

      // Clean up any existing channel/interval
      if (tabCheckChannelRef.current) {
        tabCheckChannelRef.current.close();
        tabCheckChannelRef.current = null;
      }
      if (tabCheckIntervalRef.current) {
        clearInterval(tabCheckIntervalRef.current);
        tabCheckIntervalRef.current = null;
      }

      // Use a fixed channel name that all tabs on the same origin will use
      const channelName = 'exam-tab-detection-global';
      const channel = new BroadcastChannel(channelName);
      tabCheckChannelRef.current = channel;

      // Generate unique tab ID for this tab
      const tabId = `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const activeTabs = new Set<string>([tabId]);
      let otherTabsDetected = false;
      const INITIAL_CHECK_DURATION = 3000; // Initial check for 3 seconds
      const CONTINUOUS_CHECK_INTERVAL = 2000; // Then check every 2 seconds continuously

      console.log(`🔍 Starting single tab check with tab ID: ${tabId}`);

      // Listen for messages from other tabs
      const messageHandler = (event: MessageEvent) => {
        if (event.data.type === 'tab-heartbeat') {
          const senderTabId = event.data.tabId;
          if (senderTabId && senderTabId !== tabId) {
            activeTabs.add(senderTabId);
            otherTabsDetected = true;
            console.log(`⚠️ Detected other tab: ${senderTabId}. Total tabs: ${activeTabs.size}`);
            
            // Immediately update status if another tab is detected
            setSingleTabCheck({
              status: "error",
              message: `Multiple tabs detected (${activeTabs.size} tab${activeTabs.size > 1 ? 's' : ''}). Please close all other exam tabs and keep only ONE tab open.`,
              value: activeTabs.size,
            });
            sessionStorage.removeItem("singleTabVerified");
          }
        } else if (event.data.type === 'tab-count-request') {
          // Respond to count requests from other tabs
          channel.postMessage({ 
            type: 'tab-count-response', 
            tabId: tabId,
            timestamp: Date.now() 
          });
        } else if (event.data.type === 'tab-count-response') {
          const senderTabId = event.data.tabId;
          if (senderTabId && senderTabId !== tabId) {
            activeTabs.add(senderTabId);
            otherTabsDetected = true;
            console.log(`⚠️ Received response from other tab: ${senderTabId}. Total tabs: ${activeTabs.size}`);
            
            // Immediately update status if another tab is detected
            setSingleTabCheck({
              status: "error",
              message: `Multiple tabs detected (${activeTabs.size} tab${activeTabs.size > 1 ? 's' : ''}). Please close all other exam tabs and keep only ONE tab open.`,
              value: activeTabs.size,
            });
            sessionStorage.removeItem("singleTabVerified");
          }
        }
      };
      channel.onmessage = messageHandler;

      // Send heartbeat messages continuously to detect other tabs
      const heartbeatInterval = setInterval(() => {
        channel.postMessage({ 
          type: 'tab-heartbeat', 
          tabId: tabId,
          timestamp: Date.now() 
        });
      }, 500); // Send every 500ms

      // Also request tab count from other tabs periodically
      const requestInterval = setInterval(() => {
        channel.postMessage({ 
          type: 'tab-count-request', 
          tabId: tabId,
          timestamp: Date.now() 
        });
      }, 1000); // Request every 1 second

      // Use localStorage as additional detection method
      const storageValueKey = 'exam-tab-check-value';
      
      // Listen for storage events (fired ONLY when OTHER tabs update localStorage)
      const storageEventHandler = (e: StorageEvent) => {
        if (e.key === storageValueKey && e.newValue) {
          const [otherTabId] = e.newValue.split('|');
          if (otherTabId && otherTabId !== tabId) {
            otherTabsDetected = true;
            activeTabs.add(otherTabId);
            console.log(`⚠️ Storage event detected from different tab: ${otherTabId}`);
            
            // Immediately update status
            setSingleTabCheck({
              status: "error",
              message: `Multiple tabs detected (${activeTabs.size} tab${activeTabs.size > 1 ? 's' : ''}). Please close all other exam tabs and keep only ONE tab open.`,
              value: activeTabs.size,
            });
          }
        }
      };
      window.addEventListener('storage', storageEventHandler);

      // Update localStorage periodically (this will trigger storage events in OTHER tabs)
      const storageUpdate = () => {
        try {
          const now = Date.now();
          // Store our tab ID with the timestamp
          localStorage.setItem(storageValueKey, `${tabId}|${now}`);
        } catch (e) {
          console.warn('localStorage update failed:', e);
        }
      };

      const storageInterval = setInterval(storageUpdate, 600);
      storageUpdate(); // Initial update

      // Initial check after duration
      const initialCheckTimeout = setTimeout(() => {
        const totalTabs = activeTabs.size;
        console.log(`✅ Initial tab check complete. Detected ${totalTabs} tab(s). Other tabs: ${otherTabsDetected}`);

        if (otherTabsDetected || totalTabs > 1) {
          setSingleTabCheck({
            status: "error",
            message: `Multiple tabs detected (${totalTabs} tab${totalTabs > 1 ? 's' : ''}). Please close all other exam tabs and keep only ONE tab open.`,
            value: totalTabs,
          });
        } else {
          setSingleTabCheck({
            status: "success",
            message: "Single tab confirmed. Monitoring continuously for other tabs...",
            value: 1,
          });
          sessionStorage.setItem("singleTabVerified", "true");
        }
      }, INITIAL_CHECK_DURATION);

      // Continuous monitoring - check periodically even after initial check
      const continuousCheckInterval = setInterval(() => {
        const totalTabs = activeTabs.size;
        
        if (otherTabsDetected || totalTabs > 1) {
          setSingleTabCheck({
            status: "error",
            message: `Multiple tabs detected (${totalTabs} tab${totalTabs > 1 ? 's' : ''}). Please close all other exam tabs and keep only ONE tab open.`,
            value: totalTabs,
          });
          sessionStorage.removeItem("singleTabVerified");
        } else if (singleTabCheck.status === "success") {
          // Keep success status but update message to show continuous monitoring
          setSingleTabCheck(prev => ({
            ...prev,
            message: "Single tab confirmed. Monitoring continuously for other tabs...",
          }));
        }
      }, CONTINUOUS_CHECK_INTERVAL);

      // Store intervals for cleanup
      tabCheckIntervalRef.current = continuousCheckInterval as any;

      // Cleanup function
      const cleanup = () => {
        clearTimeout(initialCheckTimeout);
        clearInterval(heartbeatInterval);
        clearInterval(requestInterval);
        clearInterval(storageInterval);
        clearInterval(continuousCheckInterval);
        window.removeEventListener('storage', storageEventHandler);
        channel.onmessage = null;
        try {
          localStorage.removeItem(storageValueKey);
        } catch (e) {
          // Ignore localStorage errors
        }
        channel.close();
        tabCheckChannelRef.current = null;
        tabCheckIntervalRef.current = null;
      };

      // Store cleanup function (will be called on unmount or when check is re-run)
      (channel as any).cleanup = cleanup;

    } catch (error) {
      console.error("Single tab check failed:", error);
      setSingleTabCheck({
        status: "error",
        message: "Unable to verify single tab. Please ensure only one exam tab is open.",
      });
    }
  }, [studentData, singleTabCheck.status]);

  const allStepsPassed = useMemo(() => {
    return (
      systemInfo.status === "success" &&
      networkTest.status === "success" &&
      screenShare.status === "success" &&
      audioCalibration.status === "success" &&
      lightingCheck.status === "success" &&
      singleTabCheck.status === "success"
    );
  }, [systemInfo, networkTest, screenShare, audioCalibration, lightingCheck, singleTabCheck]);

  const handleSave = useCallback(async () => {
    if (!studentData) return;
    if (!allStepsPassed) {
      toast.error("Please complete all checks before continuing.");
      return;
    }

    try {
      toast.loading("Saving compatibility results...", { id: "compatibility-save" });
      const { data: examData, error: examError } = await supabase
        .from("exams")
        .select("id")
        .eq("student_id", studentData.id)
        .eq("subject_code", studentData.subjectCode)
        .maybeSingle();

      if (examError || !examData) {
        throw new Error("Unable to locate exam session. Please contact support.");
      }

      const tabToken = crypto.randomUUID();

      await supabase.from("compatibility_checks").insert({
        student_id: studentData.id,
        exam_id: examData.id,
        screen_resolution: `${window.screen.width}x${window.screen.height}`,
        browser_info: {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
        },
        internet_speed_mbps: networkTest.value as number,
        screen_sharing_enabled: true,
        audio_baseline: audioCalibration.value as number,
        lighting_score: lightingCheck.value as number,
        tab_token: tabToken,
      });

      const payload = {
        completedAt: Date.now(),
        examId: examData.id,
        tabToken,
        audioBaseline: audioCalibration.value,
        lightingScore: lightingCheck.value,
      };
      sessionStorage.setItem("compatibilityCheck", JSON.stringify(payload));
      sessionStorage.setItem("examTabToken", tabToken);
      sessionStorage.setItem("singleTabVerified", "true");

      toast.success("Compatibility check saved", { id: "compatibility-save" });
      navigate("/student/exam");
    } catch (error) {
      console.error("Compatibility save failed:", error);
      toast.error("Failed to save compatibility results", { id: "compatibility-save" });
    }
  }, [studentData, allStepsPassed, networkTest, audioCalibration, lightingCheck, navigate]);

  const renderStepCard = (
    title: string,
    description: string,
    icon: React.ReactNode,
    state: StepState,
    action?: { label: string; onClick: () => void; disabled?: boolean },
    extra?: React.ReactNode,
  ) => {
    const statusColors: Record<StepStatus, string> = {
      idle: "text-muted-foreground",
      running: "text-blue-500",
      success: "text-green-600",
      error: "text-destructive",
    };

    return (
      <Card>
        <CardContent className="p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-muted rounded-lg">{icon}</div>
            <div>
              <h3 className="font-semibold">{title}</h3>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            <div className="ml-auto">
              {state.status === "success" ? (
                <Badge variant="outline" className="text-green-600 border-green-200">
                  Passed
                </Badge>
              ) : state.status === "error" ? (
                <Badge variant="destructive">Action Required</Badge>
              ) : state.status === "running" ? (
                <Badge variant="secondary" className="gap-2">
                  <Loader2 className="w-3 h-3 animate-spin" /> Checking
                </Badge>
              ) : (
                <Badge variant="outline">Pending</Badge>
              )}
            </div>
          </div>
          <div className={`text-sm ${statusColors[state.status]}`}>
            {state.message ||
              (state.status === "idle" ? "Click the button below to run this check." : null)}
          </div>
          {extra}
          {action && (
            <Button
              variant="outline"
              onClick={action.onClick}
              disabled={action.disabled || state.status === "running"}
            >
              {action.label}
            </Button>
          )}
        </CardContent>
      </Card>
    );
  };

  if (!studentData) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto py-10 px-4 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold">System Compatibility Check</h1>
          <p className="text-muted-foreground">
            Hi {studentData.name}, complete the following steps to ensure your device is ready for the
            proctored exam.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {renderStepCard(
            "System & Browser",
            "Verify screen resolution and supported browser.",
            <Monitor className="w-5 h-5" />,
            systemInfo,
            { label: "Re-run Check", onClick: checkSystemInfo },
          )}
          {renderStepCard(
            "Internet Speed",
            "We require at least 2 Mbps for continuous monitoring.",
            <Network className="w-5 h-5" />,
            networkTest,
            { label: "Run Speed Test", onClick: runSpeedTest },
          )}
          {renderStepCard(
            "Screen Sharing",
            "Allow screen capture for live monitoring.",
            <Share2 className="w-5 h-5" />,
            screenShare,
            { label: "Enable Screen Sharing", onClick: checkScreenSharing },
          )}
          {renderStepCard(
            "Audio Calibration",
            "Read the sentence aloud to calibrate your microphone.",
            <Mic className="w-5 h-5" />,
            audioCalibration,
            { label: "Start Calibration", onClick: runAudioCalibration },
            <div className="space-y-2">
              <Input value={resumeSentence} onChange={(e) => setResumeSentence(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                Read this sentence during calibration for accurate detection.
              </p>
            </div>,
          )}
          {renderStepCard(
            "Lighting Check",
            "Ensure your face is clearly visible.",
            <Sun className="w-5 h-5" />,
            lightingCheck,
            { label: "Run Lighting Test", onClick: runLightingCheck },
            <video ref={lightingVideoRef} className="hidden" playsInline muted />,
          )}
          {renderStepCard(
            "Single Tab Detection",
            "Ensure only one exam tab is open. Close all other tabs before proceeding.",
            <Lock className="w-5 h-5" />,
            singleTabCheck,
            { label: "Check Single Tab", onClick: checkSingleTab },
          )}
          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-muted rounded-lg">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-semibold">Overall Status</h3>
                  <p className="text-sm text-muted-foreground">
                    You must pass all checks to proceed to the exam.
                  </p>
                </div>
              </div>
              <Progress
                value={
                  ([
                    systemInfo.status,
                    networkTest.status,
                    screenShare.status,
                    audioCalibration.status,
                    lightingCheck.status,
                    singleTabCheck.status,
                  ].filter((status) => status === "success").length /
                    6) *
                  100
                }
              />
              <Button className="w-full" disabled={!allStepsPassed} onClick={handleSave}>
                Continue to Exam
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default CompatibilityCheck;

