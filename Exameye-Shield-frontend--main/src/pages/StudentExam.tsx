import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Shield, Clock, AlertTriangle, LogOut, Wifi, WifiOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { violationLogger } from "@/utils/violationLogger";
import { useProctoringWebSocket } from "@/hooks/useProctoringWebSocket";
import { AudioMonitor } from "@/components/AudioMonitor";
import { BrowserActivityMonitor } from "@/components/BrowserActivityMonitor";

const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 15000;

const StudentExam = () => {
  const navigate = useNavigate();
  const [studentData, setStudentData] = useState<any>(null);
  const [timeRemaining, setTimeRemaining] = useState(3600);
  const [answers, setAnswers] = useState<{ [key: number]: string }>({});
  const [examId, setExamId] = useState<string | null>(null);
  const [violationCount, setViolationCount] = useState(0);
  const [recentWarnings, setRecentWarnings] = useState<string[]>([]);
  const [questions, setQuestions] = useState<any[]>([]);
  const [questionsLoading, setQuestionsLoading] = useState(true);
  const [calibratedPitch, setCalibratedPitch] = useState(0);
  const [calibratedYaw, setCalibratedYaw] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const [copyPasteCount, setCopyPasteCount] = useState(0);
  const [windowFocused, setWindowFocused] = useState(true);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectionIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const studentNameRef = useRef<string>('Unknown Student'); // Always current student name
  const analyserRef = useRef<AnalyserNode | null>(null);
  const lastAudioSendTime = useRef<number>(0);
  const audioSilenceStartTime = useRef<number | null>(null);
  const audioSilenceAlertShown = useRef<boolean>(false);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const examSessionTokenRef = useRef<string | null>(null);
  const fullscreenTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const compatibilityInfoRef = useRef<any>(null);
  const initializationStartedRef = useRef<boolean>(false);
  const handleSubmitRef = useRef<typeof handleSubmit | null>(null);

  const AUDIO_SEND_THROTTLE_MS = 1000; // Send audio level to backend max once per second when threshold exceeded
  const AUDIO_SILENCE_THRESHOLD = 5; // Threshold for detecting silence (very low audio level)
  const AUDIO_SILENCE_DURATION_MS = 60000; // Alert after 1 minute (60 seconds) of silence
  const disconnectWebSocketRef = useRef<(() => void) | null>(null);

  // Comprehensive cleanup function to stop all media streams and resources
  // Memoized with useCallback to prevent recreation on every render
  const stopAllMediaStreams = useCallback(() => {
    console.log('🛑 Stopping all media streams and cleaning up resources...');
    
    // Stop all media tracks (video and audio)
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log(`✅ Stopped track: ${track.kind} (${track.label})`);
      });
      streamRef.current = null;
    }
    
    // Stop video element
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      console.log('✅ Video element stopped and cleared');
    }
    
    // Close audio context
    if (audioContextRef.current) {
      audioContextRef.current.close().then(() => {
        console.log('✅ Audio context closed');
      }).catch(err => {
        console.error('Error closing audio context:', err);
      });
      audioContextRef.current = null;
    }
    
    // Clear analyser reference
    analyserRef.current = null;
    
    // Clear all intervals
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
      console.log('✅ Detection interval cleared');
    }
    
    if ((window as any).audioMonitorInterval) {
      clearInterval((window as any).audioMonitorInterval);
      (window as any).audioMonitorInterval = null;
      console.log('✅ Audio monitor interval cleared');
    }
    
    console.log('✅ All media streams and resources stopped');
  }, []); // No dependencies - only uses refs which are stable

  const releaseExamSession = useCallback(async () => {
    if (!examId || !studentData || !examSessionTokenRef.current) return;
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    await supabase
      .from('exam_active_sessions')
      .update({
        is_active: false,
        last_heartbeat: new Date().toISOString(),
      })
      .eq('exam_id', examId)
      .eq('student_id', studentData.id)
      .eq('session_token', examSessionTokenRef.current);
  }, [examId, studentData]);

  const claimExamSession = useCallback(
    async (newExamId: string, studentId: string) => {
      if (!examSessionTokenRef.current) return false;
      const token = examSessionTokenRef.current;

      const { data: existing } = await supabase
        .from('exam_active_sessions')
        .select('session_token,last_heartbeat,is_active')
        .eq('exam_id', newExamId)
        .eq('student_id', studentId)
        .maybeSingle();

      if (
        existing &&
        existing.session_token !== token &&
        existing.is_active &&
        existing.last_heartbeat
      ) {
        const last = new Date(existing.last_heartbeat).getTime();
        if (Date.now() - last < HEARTBEAT_TIMEOUT_MS) {
          return false;
        }
      }

      await supabase
        .from('exam_active_sessions')
        .upsert(
          {
            exam_id: newExamId,
            student_id: studentId,
            session_token: token,
            last_heartbeat: new Date().toISOString(),
            is_active: true,
          },
          { onConflict: 'exam_id,student_id' }
        );

      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }

      heartbeatIntervalRef.current = setInterval(() => {
        supabase
          .from('exam_active_sessions')
          .update({
            last_heartbeat: new Date().toISOString(),
            is_active: true,
          })
          .eq('exam_id', newExamId)
          .eq('student_id', studentId)
          .eq('session_token', token);
      }, HEARTBEAT_INTERVAL_MS);

      return true;
    },
    []
  );

  const requestFullscreenGuard = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {
        toast.warning("Fullscreen permission is required. Please enable fullscreen mode.", {
          duration: 5000,
        });
      });
    }
  }, []);

  // WebSocket connection for Python backend
  const { isConnected: wsConnected, sendFrame, sendAudioLevel, sendBrowserActivity, disconnect: disconnectWebSocket } = useProctoringWebSocket({
    sessionId: examId || '',
    examId: examId || '',
    studentId: studentData?.id || '',
    studentName: studentNameRef.current,
    rollNo: studentData?.rollNo || '',
    subjectCode: studentData?.subjectCode || '',
    subjectName: studentData?.subjectName || studentData?.subjectCode || '',
    calibratedPitch,
    calibratedYaw,
    onViolation: async (violation) => {
      // Handle violation from Python backend - Update UI in real-time
      console.log('🚨 Violation received from backend:', violation);
      console.log('🚨 Violation keys:', Object.keys(violation));
      console.log('🚨 Violation type:', violation.type, 'violation_type:', violation.violation_type);
      console.log('🚨 Violation message:', violation.message);
      
      // Format violation message for display - handle all possible formats
      const violationType = violation.type || violation.violation_type || 'unknown';
      let message = violation.message;
      
      // Special handling for audio violations
      if (violationType === 'excessive_noise' || violation.type === 'excessive_noise') {
        // Format audio violation message with level and threshold
        if (violation.audio_level !== undefined) {
          const level = Math.round(violation.audio_level);
          const threshold = violation.threshold || 30;
          message = `Excessive noise detected - Audio level: ${level}% (Threshold: ${threshold}%)`;
        } else if (!message || message.trim() === '') {
          message = 'Excessive background noise detected';
        }
      } else if (!message || message.trim() === '') {
        // If no message, create one from type
        message = violationType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      }
      
      console.log('✅ Formatted violation message:', message, 'Type:', violationType);
      
      // Update violation count
      setViolationCount(prev => {
        const newCount = prev + 1;
        console.log('✅ Updated violation count:', newCount);
        return newCount;
      });
      
      // Update recent warnings (show last 3)
      setRecentWarnings(prev => {
        const newWarnings = [message, ...prev].slice(0, 3);
        console.log('✅ Updated recent warnings:', newWarnings);
        return newWarnings;
      });
      
      // Show toast notification
      toast.error(`Violation: ${message}`, {
        duration: 5000,
      });
      
      // Backend already saved the violation to database via WebSocket
      // No need to save again here - just update UI
    },
    enabled: !!examId && !!studentData,
  });

  // Store disconnect function in ref so it's accessible in cleanup functions
  useEffect(() => {
    disconnectWebSocketRef.current = disconnectWebSocket;
  }, [disconnectWebSocket]);

  const handleSubmit = useCallback(async () => {
    if (!examId || !studentData) return;

    try {
      toast.info("Submitting and grading your exam...");
      
      // 1. Save all answers
      const promises = Object.entries(answers).map(([questionNum, answer]) =>
        supabase
          .from('exam_answers')
          .upsert({
            exam_id: examId,
            student_id: studentData.id,
            question_number: parseInt(questionNum),
            answer: answer,
            updated_at: new Date().toISOString()
          })
      );

      await Promise.all(promises);

      // 2. Mark exam as completed
      await supabase
        .from('exams')
        .update({ 
          status: 'completed',
          completed_at: new Date().toISOString()
        })
        .eq('id', examId);

      await releaseExamSession();

      // 3. Auto-grade the exam
      const backendUrl = import.meta.env.VITE_PROCTORING_API_URL || 'http://localhost:8001';
      const gradeResponse = await fetch(`${backendUrl}/api/grade-exam`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exam_id: examId,
          student_id: studentData.id,
          answers: Object.entries(answers).map(([questionNum, answer]) => ({
            question_number: parseInt(questionNum),
            answer: answer
          }))
        })
      });

      const gradeData = await gradeResponse.json();
      
      if (gradeData.success) {
        // Show results immediately
        toast.success(`Exam submitted and graded!`, {
          description: `Score: ${gradeData.total_score}/${gradeData.max_score} (${gradeData.percentage}%) - Grade: ${gradeData.grade_letter}`,
          duration: 10000
        });
        
        console.log('📊 Grading Results:', gradeData);
      } else {
        toast.warning("Exam submitted but grading failed. Admin will grade manually.");
      }
      
      // Stop all media streams and cleanup resources BEFORE navigation
      stopAllMediaStreams();
      
      // Disconnect WebSocket
      if (disconnectWebSocket) {
        disconnectWebSocket();
        console.log('✅ WebSocket disconnected');
      }

      // Redirect after showing results
      setTimeout(() => {
        navigate('/', { replace: true });
      }, 3000);
    } catch (error) {
      console.error('Error submitting:', error);
      toast.error("Failed to submit");
      // Still cleanup even if submission fails
      stopAllMediaStreams();
      if (disconnectWebSocket) {
        disconnectWebSocket();
      }
      releaseExamSession();
    }
  }, [examId, studentData, answers, navigate, stopAllMediaStreams, disconnectWebSocket, releaseExamSession]);

  // Store handleSubmit in ref so it's always current for timer
  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  useEffect(() => {
    // Prevent multiple initializations
    if (initializationStartedRef.current) {
      return;
    }
    initializationStartedRef.current = true;

    const compatibilityRaw = sessionStorage.getItem('compatibilityCheck');
    const tabToken = sessionStorage.getItem('examTabToken');
    if (!compatibilityRaw || !tabToken) {
      toast.error("Please run the compatibility check before starting the exam.");
      navigate('/student/compatibility');
      initializationStartedRef.current = false; // Reset on redirect
      return;
    }
    try {
      compatibilityInfoRef.current = JSON.parse(compatibilityRaw);
    } catch (err) {
      console.error('Invalid compatibility payload', err);
      toast.error("Compatibility data corrupted. Please rerun the checks.");
      sessionStorage.removeItem('compatibilityCheck');
      navigate('/student/compatibility');
      initializationStartedRef.current = false; // Reset on redirect
      return;
    }
    examSessionTokenRef.current = tabToken;

    const data = sessionStorage.getItem('studentData');
    if (!data) {
      toast.error("Please register first");
      navigate('/student/register');
      initializationStartedRef.current = false; // Reset on redirect
      return;
    }
    const parsedData = JSON.parse(data);
    setStudentData(parsedData);
    // Update the ref immediately so it's always current
    studentNameRef.current = parsedData.name || 'Unknown Student';
    console.log('✅ Student name loaded and saved to ref:', studentNameRef.current);

    // Start exam first to get examId, then load questions and initialize monitoring
    startExam(parsedData).then(async (startedExamId) => {
      if (!startedExamId) {
        toast.error("Failed to start exam. Please try again.");
        initializationStartedRef.current = false; // Reset on failure
        return;
      }
      
      // Load exam questions after examId is set
      await loadExamQuestions();
      
      // Claim exam session and initialize proctoring
      const allowed = await claimExamSession(startedExamId, parsedData.id);
      if (!allowed) {
        toast.error("Exam already active in another tab. Please close other tabs.");
        navigate('/', { replace: true });
        initializationStartedRef.current = false; // Reset on redirect
        return;
      }
      
      console.log('✅ Exam started, examId:', startedExamId);
      console.log('✅ Loading questions and initializing proctoring system...');
      
      requestFullscreenGuard();
      
      // Initialize proctoring monitoring (camera, microphone, WebSocket)
      try {
        await initializeMonitoring();
        console.log('✅ Proctoring system initialized successfully - Camera, microphone, and WebSocket ready');
      } catch (error) {
        console.error('❌ Failed to initialize proctoring:', error);
        toast.error("Failed to initialize proctoring system. Please check your camera and microphone permissions.");
      }
      
      // Note: WebSocket connection will be established automatically via useProctoringWebSocket hook
      // once examId and studentData are set (enabled: !!examId && !!studentData)
      console.log('✅ WebSocket connection will be established automatically');
    }).catch((error) => {
      console.error('❌ Error starting exam:', error);
      toast.error("Failed to start exam. Please try again.");
      initializationStartedRef.current = false; // Reset on error
    });

    const timer = setInterval(() => {
      setTimeRemaining(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          // Use ref to get current handleSubmit
          if (handleSubmitRef.current) {
            handleSubmitRef.current();
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // Auto-submit exam and redirect to homepage if back button pressed
    const handleBackButton = async (e: PopStateEvent) => {
      e.preventDefault();
      
      // Show warning toast
      toast.error("Back button pressed! Auto-submitting exam...", {
        description: "Redirecting to homepage",
        duration: 3000
      });
      
      // Stop all media streams and cleanup
      stopAllMediaStreams();
      
      // Disconnect WebSocket if available
      if (disconnectWebSocketRef.current) {
        disconnectWebSocketRef.current();
        console.log('✅ WebSocket disconnected on back button');
      }

      releaseExamSession();
      
      // Auto-submit the exam
      if (examId && studentData) {
        try {
          // Save current answers
          const promises = Object.entries(answers).map(([questionNum, answer]) =>
            supabase
              .from('exam_answers')
              .upsert({
                exam_id: examId,
                student_id: studentData.id,
                question_number: parseInt(questionNum),
                answer: answer,
                updated_at: new Date().toISOString()
              })
          );
          await Promise.all(promises);
          
          // Mark exam as completed
          await supabase
            .from('exams')
            .update({ 
              status: 'completed',
              completed_at: new Date().toISOString()
            })
            .eq('id', examId);
          
          console.log('✅ Exam auto-submitted due to back navigation');
        } catch (error) {
          console.error('Error auto-submitting exam:', error);
        }
      }
      
      // Redirect to homepage
      setTimeout(() => {
        navigate('/', { replace: true });
      }, 1000);
    };

    // Push initial state and block back button
    window.history.pushState(null, '', window.location.pathname);
    window.addEventListener('popstate', handleBackButton);

    return () => {
      clearInterval(timer);
      // Use comprehensive cleanup function
      stopAllMediaStreams();
      // Disconnect WebSocket if available
      if (disconnectWebSocketRef.current) {
        disconnectWebSocketRef.current();
        console.log('✅ WebSocket disconnected on cleanup');
      }
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      releaseExamSession();
      // Remove back button listener
      window.removeEventListener('popstate', handleBackButton);
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
      // Don't reset guard here - only reset on actual navigation/errors
      // This prevents re-initialization when dependencies change
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run only once on mount - use refs for functions that need to be current

  useEffect(() => {
    const lightingScore = compatibilityInfoRef.current?.lightingScore;
    if (typeof lightingScore === 'number') {
      if (lightingScore < 35 || lightingScore > 90) {
        toast.warning("Lighting conditions may be suboptimal. Please ensure your face is clearly visible.", {
          duration: 6000,
        });
      }
    }
  }, []);

  // Enforce fullscreen – auto-submit if student exits
  useEffect(() => {
    if (!examId) return;

    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        toast.error("Fullscreen is required. Returning to fullscreen or exam will submit automatically.");
        if (!fullscreenTimeoutRef.current) {
          fullscreenTimeoutRef.current = setTimeout(() => {
            toast.error("Exam submitted due to leaving fullscreen.");
            if (handleSubmitRef.current) {
              handleSubmitRef.current();
            }
          }, 5000);
        }
      } else if (fullscreenTimeoutRef.current) {
        clearTimeout(fullscreenTimeoutRef.current);
        fullscreenTimeoutRef.current = null;
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      if (fullscreenTimeoutRef.current) {
        clearTimeout(fullscreenTimeoutRef.current);
        fullscreenTimeoutRef.current = null;
      }
    };
  }, [examId]); // handleSubmit accessed via ref, no need in deps

  // Separate useEffect for browser activity monitoring with proper dependencies
  useEffect(() => {
    if (!examId || !studentData) return;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        console.log('🔄 Tab switch detected');
        
        // Always increment counter for UI display
        setTabSwitchCount(prev => {
          const newCount = prev + 1;
          console.log('Tab switch count updated:', newCount);
          return newCount;
        });
        
        // Send tab switch through WebSocket to backend if connected
        if (wsConnected) {
          console.log('📤 Sending tab switch to backend via WebSocket');
          sendBrowserActivity('tab_switch', 'Tab switched - student navigated away from exam page');
        } else {
          console.warn('⚠️ WebSocket not connected, tab switch not sent to backend');
        }
      }
      setWindowFocused(!document.hidden);
    };

    const handleCopyPaste = (e: Event) => {
      e.preventDefault();
      const eventType = e.type === 'copy' ? 'copy' : 'paste';
      console.log(`📋 ${eventType.toUpperCase()} event detected`);
      
      // Always increment counter for UI display
      setCopyPasteCount(prev => {
        const newCount = prev + 1;
        console.log('Copy/Paste count updated:', newCount);
        return newCount;
      });
      
      // Send copy/paste through WebSocket to backend if connected
      if (wsConnected) {
        console.log(`📤 Sending ${eventType} to backend via WebSocket`);
        sendBrowserActivity('copy_paste', `${eventType.charAt(0).toUpperCase() + eventType.slice(1)} operation attempted`);
      } else {
        console.warn('⚠️ WebSocket not connected, copy/paste not sent to backend');
      }
    };

    // Attach listeners as soon as exam starts (don't wait for WebSocket)
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('copy', handleCopyPaste);
    document.addEventListener('paste', handleCopyPaste);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('copy', handleCopyPaste);
      document.removeEventListener('paste', handleCopyPaste);
    };
  }, [examId, studentData, wsConnected, sendBrowserActivity]);

  const initializeMonitoring = async () => {
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: 640, height: 480 }, 
          audio: true 
        });
      } catch (firstError) {
        console.warn('First media request failed, retrying...', firstError);
        await new Promise((resolve) => setTimeout(resolve, 500));
        stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: 640, height: 480 }, 
          audio: true 
        });
      }
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      
      streamRef.current = stream;

      // Setup audio monitoring
      audioContextRef.current = new AudioContext();
      analyserRef.current = audioContextRef.current.createAnalyser();
      const source = audioContextRef.current.createMediaStreamSource(stream);
      source.connect(analyserRef.current);
      analyserRef.current.fftSize = 256;

      // Start continuous audio level monitoring (updates UI frequently and sends to backend when threshold exceeded)
      const audioMonitorInterval = setInterval(() => {
        if (analyserRef.current) {
          const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
          analyserRef.current.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
          const normalizedLevel = Math.min(Math.round((average / 255) * 100), 100);
          setAudioLevel(normalizedLevel);
          
          const now = Date.now();
          
          // Check for audio silence (no audio for more than 5 seconds)
          if (normalizedLevel <= AUDIO_SILENCE_THRESHOLD) {
            // Audio is very low or silent
            if (audioSilenceStartTime.current === null) {
              // Start tracking silence
              audioSilenceStartTime.current = now;
              audioSilenceAlertShown.current = false;
              console.log('🔇 Audio silence detected, starting timer...');
            } else {
              // Check if silence has lasted more than 1 minute
              const silenceDuration = now - audioSilenceStartTime.current;
              if (silenceDuration >= AUDIO_SILENCE_DURATION_MS && !audioSilenceAlertShown.current) {
                // Show alert for microphone not working (popup only, no Active Alerts entry)
                audioSilenceAlertShown.current = true;
                toast.error("No audio detected for more than 1 minute. Please enable your microphone.", {
                  duration: 8000,
                  description: "Check your microphone settings and ensure it's enabled."
                });
                console.log('⚠️ Audio silence alert shown - no audio for 1+ minute');
              }
            }
          } else {
            // Audio is detected, reset silence tracking
            if (audioSilenceStartTime.current !== null) {
              console.log('✅ Audio detected again, resetting silence timer');
              audioSilenceStartTime.current = null;
              audioSilenceAlertShown.current = false;
            }
          }
          
          // Send to backend immediately if threshold is exceeded (throttled to prevent spam)
          // IMPORTANT: Always send audio level when threshold is exceeded so backend can detect violations
          if (normalizedLevel >= 30 && wsConnected) {
            // Send immediately if threshold exceeded (no throttle for violation detection)
            sendAudioLevel(normalizedLevel, studentNameRef.current);
            lastAudioSendTime.current = now;
            console.log(`🔊 Audio level ${normalizedLevel}% exceeds threshold (30%), sent to backend with student: ${studentNameRef.current}`);
          } else if (normalizedLevel >= 25 && wsConnected && (now - lastAudioSendTime.current) >= AUDIO_SEND_THROTTLE_MS) {
            // Also send moderate levels periodically for monitoring (throttled)
            sendAudioLevel(normalizedLevel, studentNameRef.current);
            lastAudioSendTime.current = now;
          }
        }
      }, 100); // Update audio level every 100ms for smooth UI

      // Store interval for cleanup
      (window as any).audioMonitorInterval = audioMonitorInterval;

      // Get calibration from session storage
      const calibrationData = sessionStorage.getItem('calibration');
      if (calibrationData) {
        const { pitch, yaw } = JSON.parse(calibrationData);
        setCalibratedPitch(pitch);
        setCalibratedYaw(yaw);
        console.log('✅ Calibration loaded:', { pitch, yaw });
      } else {
        console.warn('⚠️ No calibration data found in session storage!');
        toast.warning('Head pose calibration not found. Detection accuracy may be reduced.', {
          duration: 5000
        });
      }

      // Wait for WebSocket connection before starting AI monitoring
      console.log('⏳ Waiting for WebSocket connection before starting AI monitoring...');
      const maxWaitTime = 10000; // 10 seconds max wait
      const checkInterval = 100; // Check every 100ms
      let elapsedTime = 0;
      
      const waitForConnection = setInterval(() => {
        elapsedTime += checkInterval;
        console.log(`🔍 Checking WebSocket status: wsConnected=${wsConnected}, examId=${!!examId}, studentData=${!!studentData}`);
        
        if (wsConnected && examId && studentData) {
          console.log('✅ WebSocket connected and ready! Starting AI monitoring...');
          clearInterval(waitForConnection);
          startAIMonitoring();
        } else if (elapsedTime >= maxWaitTime) {
          console.warn('⚠️ WebSocket connection timeout - starting AI monitoring anyway');
          clearInterval(waitForConnection);
          startAIMonitoring();
        }
      }, checkInterval);
    } catch (error) {
      console.error('Camera error:', error);
      toast.error("Camera access required");
    }
  };

  const startAIMonitoring = () => {
    console.log('🎬 Starting AI monitoring - capturing frames every 2 seconds');
    console.log('📊 Initial state:', { 
      hasVideo: !!videoRef.current, 
      hasStream: !!streamRef.current, 
      hasExamId: !!examId, 
      hasStudentData: !!studentData,
      wsConnected 
    });
    
    detectionIntervalRef.current = setInterval(async () => {
      // Only check video/stream at capture time
      if (!videoRef.current || !streamRef.current) {
        console.warn('⚠️ Cannot capture frame - no video/stream');
        return;
      }

      try {
        console.log('📸 Capturing frame...');
        // Capture frame from video
        const canvas = document.createElement('canvas');
        canvas.width = videoRef.current.videoWidth;
        canvas.height = videoRef.current.videoHeight;
        
        // Skip if video hasn't loaded yet
        if (canvas.width === 0 || canvas.height === 0) {
          console.warn('⚠️ Video not ready yet (dimensions 0x0)');
          return;
        }
        
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        ctx.drawImage(videoRef.current, 0, 0);
        const snapshot = canvas.toDataURL('image/jpeg', 0.8);
        console.log(`📷 Frame captured: ${snapshot.substring(0, 50)}... (${snapshot.length} bytes)`);
        
        // Get audio level and normalize to 0-100 scale
        let currentAudioLevel = 0;
        if (analyserRef.current) {
          const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
          analyserRef.current.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
          // Normalize from 0-255 to 0-100 scale
          currentAudioLevel = Math.min(Math.round((average / 255) * 100), 100);
        }

        // Always update audio level state for UI display (real-time update)
        setAudioLevel(currentAudioLevel);

        // Send to backend via WebSocket - use ref to get always-current student name
        const currentStudentName = studentNameRef.current;
        console.log(`📡 Attempting to send frame to backend (audio: ${currentAudioLevel}%, student: ${currentStudentName})`);
        sendFrame(snapshot, currentAudioLevel, currentStudentName);
        
        // Also send audio level separately with student name
        console.log(`🔊 Sending audio level ${currentAudioLevel}% with student name: ${currentStudentName}`);
        sendAudioLevel(currentAudioLevel, currentStudentName);
        console.log('✅ Frame send attempted with student name:', currentStudentName);
      } catch (error) {
        console.error('❌ AI monitoring error:', error);
      }
    }, 2000);
  };

  const loadExamQuestions = async () => {
    try {
      setQuestionsLoading(true);
      const data = sessionStorage.getItem('studentData');
      if (!data) {
        setQuestionsLoading(false);
        return;
      }
      
      const parsedData = JSON.parse(data);
      
      // Get exam template ID for this subject
      const { data: examData, error: examError } = await supabase
        .from('exams')
        .select('exam_template_id')
        .eq('subject_code', parsedData.subjectCode)
        .eq('student_id', parsedData.id)
        .single();

      if (examError) throw examError;

      // Get template duration
      const { data: templateData } = await supabase
        .from('exam_templates')
        .select('duration_minutes')
        .eq('id', examData.exam_template_id)
        .single();

      // Set exam duration from template (default 15 minutes)
      const durationMinutes = templateData?.duration_minutes || 15;
      setTimeRemaining(durationMinutes * 60);

      // Load questions for this exam template
      const { data: questionsData, error } = await supabase
        .from('exam_questions')
        .select('*')
        .eq('exam_template_id', examData.exam_template_id)
        .order('question_number');

      if (error) throw error;

      if (questionsData && questionsData.length > 0) {
        setQuestions(questionsData);
        console.log(`✅ Loaded ${questionsData.length} exam questions`);
      } else {
        toast.error("No questions found for this exam");
        setQuestions([]);
      }
    } catch (error) {
      console.error('Error loading questions:', error);
      toast.error("Failed to load exam questions");
      setQuestions([]);
    } finally {
      setQuestionsLoading(false);
    }
  };

  const startExam = async (data: any) => {
    try {
      const { data: exams, error } = await supabase
        .from('exams')
        .select('id')
        .eq('subject_code', data.subjectCode)
        .eq('student_id', data.id)
        .single();

      if (error) throw error;

      setExamId(exams.id);

      await supabase
        .from('exams')
        .update({ 
          status: 'in_progress',
          started_at: new Date().toISOString()
        })
        .eq('id', exams.id);

      return exams.id;
    } catch (error) {
      console.error('Error starting exam:', error);
      return null;
    }
  };

  const recordViolation = async (type: string, details: string) => {
    if (!examId || !studentData) return;

    try {
      // NO SNAPSHOT for browser activity violations (tab_switch, copy_paste)
      // Snapshots are ONLY for AI violations handled by WebSocket (person/object detection)
      const browserActivityTypes = ['tab_switch', 'copy_paste', 'window_blur'];
      const shouldCaptureSnapshot = !browserActivityTypes.includes(type);
      
      let imageUrl = null;
      
      // Only capture snapshot for AI violations, NOT for browser activity
      if (shouldCaptureSnapshot && videoRef.current) {
        const canvas = document.createElement('canvas');
        canvas.width = videoRef.current.videoWidth;
        canvas.height = videoRef.current.videoHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(videoRef.current, 0, 0);
          const snapshot = canvas.toDataURL('image/jpeg', 0.8);
          
          // Upload snapshot
          imageUrl = await violationLogger.uploadSnapshot(
            examId,
            studentData.id,
            studentData.name,
            snapshot,
            type
          );
        }
      }
      
      // Save to backend API which will store in Supabase
      const backendUrl = import.meta.env.REACT_APP_BACKEND_URL || 'http://localhost:8001';
      
      // Save violation to backend API
      await fetch(`${backendUrl}/api/violations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exam_id: examId,
          student_id: studentData.id,
          violation_type: type,
          severity: 'medium',
          details: { 
            message: details,
            student_name: studentData.name
          },
          image_url: imageUrl
        })
      });

      setViolationCount(prev => prev + 1);
      toast.warning("Violation recorded: " + details);
    } catch (error) {
      console.error('Error recording violation:', error);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  if (!studentData) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Preparing your exam workspace...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
              <Shield className="w-6 h-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="font-bold">Proctored Exam</h1>
              <p className="text-xs text-muted-foreground">{studentData.name} - {studentData.subjectName || studentData.subjectCode}</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              {wsConnected ? (
                <Wifi className="w-4 h-4 text-green-500" />
              ) : (
                <WifiOff className="w-4 h-4 text-orange-500" />
              )}
              <Clock className="w-4 h-4" />
              <span className="text-lg font-mono font-bold">{formatTime(timeRemaining)}</span>
            </div>
            <Button variant="destructive" size="sm" onClick={handleSubmit}>
              <LogOut className="w-4 h-4 mr-2" />
              End Exam
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-6">
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Main Content */}
          <div className="lg:col-span-2">
            <Card>
              <CardContent className="p-6">
                <h2 className="text-2xl font-bold mb-6">Examination Paper</h2>
                
                {questionsLoading ? (
                  <div className="flex flex-col items-center justify-center py-12">
                    <Loader2 className="w-8 h-8 animate-spin text-primary mb-4" />
                    <p className="text-sm text-muted-foreground">Loading exam questions...</p>
                  </div>
                ) : questions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12">
                    <AlertTriangle className="w-8 h-8 text-muted-foreground mb-4" />
                    <p className="text-sm text-muted-foreground">No questions available for this exam.</p>
                  </div>
                ) : (
                  <div className="space-y-8">
                    {questions.map((question, index) => (
                    <div key={question.id} className="space-y-4 p-4 border rounded-lg">
                      <div className="flex items-start gap-2">
                        <span className="font-semibold text-primary">Q{question.question_number}.</span>
                        <p className="font-medium flex-1">{question.question_text}</p>
                      </div>
                      
                      {question.question_type === 'mcq' && question.options ? (
                        <div className="space-y-3 ml-6">
                          {Object.entries(question.options).map(([key, value]: [string, any]) => (
                            <label
                              key={key}
                              className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-all hover:bg-accent ${
                                answers[question.question_number] === key
                                  ? 'border-primary bg-primary/5'
                                  : 'border-border'
                              }`}
                            >
                              <input
                                type="radio"
                                name={`question-${question.question_number}`}
                                value={key}
                                checked={answers[question.question_number] === key}
                                onChange={(e) =>
                                  setAnswers({ ...answers, [question.question_number]: e.target.value })
                                }
                                className="mt-1"
                              />
                              <div className="flex-1">
                                <span className="font-semibold text-sm uppercase mr-2">{key})</span>
                                <span>{value}</span>
                              </div>
                            </label>
                          ))}
                        </div>
                      ) : (
                        <Textarea
                          placeholder="Type your answer here..."
                          value={answers[question.question_number] || ''}
                          onChange={(e) =>
                            setAnswers({ ...answers, [question.question_number]: e.target.value })
                          }
                          rows={6}
                          className="resize-none ml-6"
                        />
                      )}
                    </div>
                  ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            {/* Live Monitoring */}
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
                    <h3 className="font-semibold">Live Monitoring</h3>
                  </div>
                  <Badge variant="destructive" className="text-xs">LIVE</Badge>
                </div>
                
                <div className="relative aspect-video bg-muted rounded-lg overflow-hidden border-2 border-primary">
                  <video 
                    ref={videoRef} 
                    autoPlay 
                    muted 
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute top-2 left-2 flex flex-col gap-1">
                    <Badge variant="destructive" className="text-xs">
                      🔴 MONITORING
                    </Badge>
                    <Badge className="text-xs bg-green-600">
                      ✓ Active Monitoring
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Audio Monitor */}
            <AudioMonitor audioLevel={audioLevel} threshold={30} />

            {/* Browser Activity Monitor */}
            <BrowserActivityMonitor 
              tabSwitches={tabSwitchCount}
              copyPasteEvents={copyPasteCount}
              windowFocus={windowFocused}
            />

            {/* Active Alerts */}
            <Card className={recentWarnings.length > 0 ? 'border-destructive border-2' : ''}>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle className={`w-4 h-4 ${recentWarnings.length > 0 ? 'text-destructive animate-pulse' : 'text-warning'}`} />
                  <h3 className={`font-semibold ${recentWarnings.length > 0 ? 'text-destructive' : ''}`}>Active Alerts</h3>
                  {recentWarnings.length > 0 && (
                    <Badge variant="destructive" className="ml-auto">
                      {recentWarnings.length} Active
                    </Badge>
                  )}
                </div>
                <div className="min-h-[24px]">
                  {recentWarnings.length > 0 ? (
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0 animate-pulse" />
                      <p className="text-sm text-destructive font-medium">{recentWarnings[0]}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No violations detected</p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Total Violations */}
            <Card>
              <CardContent className="p-4 text-center">
                <p className="text-6xl font-bold text-destructive">{violationCount}</p>
                <p className="text-sm text-muted-foreground mt-2">Total Violations</p>
              </CardContent>
            </Card>

            {/* Recent Warnings */}
            <Card>
              <CardContent className="p-4">
                <h3 className="font-semibold mb-3">Recent Warnings</h3>
                {recentWarnings.length > 0 ? (
                  <div className="space-y-2">
                    {recentWarnings.map((warning, index) => (
                      <div key={index} className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
                        <p className="text-sm text-destructive font-medium">{warning}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No warnings yet</p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StudentExam;
