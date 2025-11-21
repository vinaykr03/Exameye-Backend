import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Shield, Activity, Users, AlertTriangle, LogOut, Upload, RefreshCw, Download, FileText, Eye, Monitor, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { pdfGenerator } from "@/utils/pdfGenerator";

const AdminDashboard = () => {
  const navigate = useNavigate();
  const [examSessions, setExamSessions] = useState<any[]>([]);
  const [violations, setViolations] = useState<any[]>([]);
  const [stats, setStats] = useState({
    totalSessions: 0,
    activeNow: 0,
    completed: 0,
    totalViolations: 0,
    avgViolationsPerStudent: 0,
    avgExamDuration: 0,
    totalStudents: 0,
  });
  type ChartPoint = { bucket: number; label: string; violations: number };
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [studentsWithViolations, setStudentsWithViolations] = useState<any[]>([]);
  const [completedStudents, setCompletedStudents] = useState<any[]>([]);

  const BUCKET_INTERVAL_MINUTES = 5;
  const BUCKET_INTERVAL_MS = BUCKET_INTERVAL_MINUTES * 60 * 1000;

  const getBucketInfo = (date: Date) => {
    const bucket = Math.floor(date.getTime() / BUCKET_INTERVAL_MS) * BUCKET_INTERVAL_MS;
    const label = new Date(bucket).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    return { bucket, label };
  };

  // Incremental chart update for real-time responsiveness
  const updateChartDataIncremental = (payload: any) => {
    if (payload.eventType === 'INSERT' && payload.new) {
      const violation = payload.new;
      const time = new Date(violation.timestamp);
      const { bucket, label } = getBucketInfo(time);
      
      setChartData(prevData => {
        const newData = [...prevData];
        const existingIndex = newData.findIndex(d => d.bucket === bucket);
        
        if (existingIndex >= 0) {
          // Update existing time point
          newData[existingIndex] = {
            ...newData[existingIndex],
            violations: newData[existingIndex].violations + 1
          };
        } else {
          // Add new time point
          newData.push({ bucket, label, violations: 1 });
          // Sort and keep last 20
          newData.sort((a, b) => a.bucket - b.bucket);
          return newData.slice(-20);
        }
        
        return newData.sort((a, b) => a.bucket - b.bucket);
      });
    } else if (payload.eventType === 'DELETE' && payload.old) {
      // Handle deletion (less common but should be handled)
      const violation = payload.old;
      const time = new Date(violation.timestamp);
      const { bucket } = getBucketInfo(time);
      
      setChartData(prevData => {
        const newData = [...prevData];
        const existingIndex = newData.findIndex(d => d.bucket === bucket);
        
        if (existingIndex >= 0 && newData[existingIndex].violations > 0) {
          newData[existingIndex] = {
            ...newData[existingIndex],
            violations: Math.max(0, newData[existingIndex].violations - 1)
          };
        }
        
        return newData;
      });
    }
  };

  useEffect(() => {
    const isAuthenticated = sessionStorage.getItem('adminAuth');
    if (!isAuthenticated) {
      toast.error("Please login as admin");
      navigate('/admin/login');
      return;
    }

    loadDashboardData();

    // Real-time subscriptions - listen to all violation events for immediate chart updates
    const violationSubscription = supabase
      .channel('violations-channel')
      .on('postgres_changes', 
        { event: '*', schema: 'public', table: 'violations' },
        (payload) => {
          console.log('Violation change detected:', payload.eventType, payload.new);
          if (payload.eventType === 'INSERT') {
            toast.error('New violation detected!', {
              description: payload.new?.violation_type?.replace(/_/g, ' ') || 'Unknown type'
            });
          }
          // Immediately update chart data when violations change
          updateChartDataIncremental(payload);
          // Also reload full data to ensure consistency
          loadDashboardData();
        }
      )
      .subscribe();

    const examsSubscription = supabase
      .channel('exams-channel')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'exams' },
        () => {
          loadDashboardData();
        }
      )
      .subscribe();

    // Auto-refresh every 10 seconds
    const interval = setInterval(loadDashboardData, 10000);

    return () => {
      clearInterval(interval);
      supabase.removeChannel(violationSubscription);
      supabase.removeChannel(examsSubscription);
    };
  }, [navigate]);

  const loadDashboardData = async () => {
    try {
      const { data: examsData, error: examsError } = await supabase
        .from('exams')
        .select(`
          *,
          students (
            name,
            email,
            student_id,
            roll_no
          ),
          exam_templates (
            subject_name,
            subject_code
          )
        `)
        .order('started_at', { ascending: false });

      if (examsError) throw examsError;

      // Fetch all violations - don't require foreign key joins (allow NULLs)
      const { data: violationsData } = await supabase
        .from('violations')
        .select('*')
        .order('timestamp', { ascending: false });

      // Also fetch all students to get roll_no for students not in exam relationships
      // Handle case where roll_no column might not exist yet
      let studentRollNoMap = new Map<string, string>();
      try {
        const { data: studentsData, error: studentsError } = await supabase
          .from('students')
          .select('id, roll_no, name, student_id');
        
        if (!studentsError && studentsData) {
          // Create a map of student_id to roll_no for quick lookup
          studentsData.forEach((student: any) => {
            if (student.id && student.roll_no) {
              studentRollNoMap.set(student.id, student.roll_no);
            }
            if (student.student_id && student.roll_no) {
              studentRollNoMap.set(student.student_id, student.roll_no);
            }
          });
        }
      } catch (error) {
        console.warn('Could not fetch students roll_no (column may not exist yet):', error);
      }

      setViolations(violationsData || []);
      // Store student roll_no map for use in grouping
      (window as any).studentRollNoMap = studentRollNoMap;

      // Calculate stats
      const activeCount = (examsData || []).filter(e => e.status === 'in_progress').length;
      const completedCount = (examsData || []).filter(e => e.status === 'completed').length;
      const totalViolations = violationsData?.length || 0;
      const totalStudents = new Set((examsData || []).map(e => e.student_id)).size;
      
      const avgViolations = totalStudents > 0 ? (totalViolations / totalStudents).toFixed(1) : 0;
      
      const completedExams = (examsData || []).filter(e => e.status === 'completed' && e.started_at && e.completed_at);
      const avgDuration = completedExams.length > 0
        ? Math.round(completedExams.reduce((sum, e) => {
            const start = new Date(e.started_at).getTime();
            const end = new Date(e.completed_at).getTime();
            return sum + (end - start) / 1000 / 60;
          }, 0) / completedExams.length)
        : 0;

      setStats({
        totalSessions: examsData?.length || 0,
        activeNow: activeCount,
        completed: completedCount,
        totalViolations,
        avgViolationsPerStudent: Number(avgViolations),
        avgExamDuration: avgDuration,
        totalStudents,
      });

      const safeExams = examsData || [];
      const safeViolations = violationsData || [];

      setExamSessions(safeExams);
      prepareChartData(safeViolations);
      groupViolationsByStudent(safeExams, safeViolations);
      buildCompletedStudents(safeExams, safeViolations);

    } catch (error) {
      console.error('Error loading dashboard data:', error);
    }
  };

  const prepareChartData = (violations: any[]) => {
    const bucketMap: Record<number, { bucket: number; label: string; violations: number }> = {};
    
    violations.forEach(v => {
      const date = new Date(v.timestamp);
      const { bucket, label } = getBucketInfo(date);
      if (!bucketMap[bucket]) {
        bucketMap[bucket] = { bucket, label, violations: 0 };
      }
      bucketMap[bucket].violations += 1;
    });

    const data = Object.values(bucketMap)
      .sort((a, b) => a.bucket - b.bucket)
      .slice(-20); // Show last 20 time points for better visibility

    setChartData(data);
  };

  const groupViolationsByStudent = (exams: any[], violations: any[]) => {
    const studentMap: { [key: string]: any } = {};

    // Helper to normalize student name for matching
    const normalizeName = (name: string) => (name || '').toLowerCase().trim();
    
    // Helper to extract student info from violation
    const getStudentInfo = (violation: any) => {
      const vDetails = violation.details as any;
      const studentId = violation.student_id || vDetails?.student_id || 'unknown';
      // CRITICAL: Prioritize details.student_name as it's the most reliable source
      const studentName = vDetails?.student_name || (violation as any).student_name || 'Unknown Student';
      const subjectCode = vDetails?.subject_code || '';
      
      // Debug log for violations with Unknown Student
      if (studentName === 'Unknown Student') {
        console.warn('⚠️ Unknown Student found in violation:', {
          violation_type: violation.violation_type,
          has_details: !!violation.details,
          details_student_name: vDetails?.student_name,
          violation_student_name: (violation as any).student_name,
          student_id: studentId
        });
      }
      
      return { studentId, studentName, subjectCode, normalizedName: normalizeName(studentName) };
    };

    // First pass: Group violations by student name, student_id, AND exam_id/subject_code
    // This prevents merging violations from different exam sessions
    violations.forEach(violation => {
      const { studentId, studentName, subjectCode, normalizedName } = getStudentInfo(violation);
      
      // Skip if no valid student name
      if (normalizedName === '' || normalizedName === 'unknown student') {
        return;
      }
      
      // CRITICAL: Find the exam for this violation first
      let exam = null;
      const violationExamId = violation.exam_id || '';
      
      // 1. Try to find by exam_id from violation (most reliable)
      if (violationExamId) {
        exam = exams.find(e => e.id === violationExamId);
      }
      
      // 2. Try to find by student_id (UUID match) + subject_code
      if (!exam && studentId && studentId !== 'unknown' && studentId.length > 10) {
        exam = exams.find(e => {
          const examStudentId = e.students?.id || e.student_id || '';
          const examSubjectCode = e.exam_templates?.subject_code || e.subject_code || '';
          return (examStudentId === studentId || (e.students?.student_id && e.students.student_id === studentId)) &&
                 (subjectCode && examSubjectCode === subjectCode);
        });
      }
      
      // 3. Try to find by student name + subject code
      if (!exam && subjectCode) {
        exam = exams.find(e => {
          const examSubjectCode = e.exam_templates?.subject_code || e.subject_code || '';
          const examStudentName = e.students?.name || '';
          return examSubjectCode === subjectCode && 
                 normalizeName(examStudentName) === normalizedName;
        });
      }
      
      // 4. Try to find by student_id (UUID match) only
      if (!exam && studentId && studentId !== 'unknown' && studentId.length > 10) {
        exam = exams.find(e => {
          const examStudentId = e.students?.id || e.student_id || '';
          return examStudentId === studentId || 
                 (e.students?.student_id && e.students.student_id === studentId);
        });
      }
      
      // 5. Try to find by student name only
      if (!exam) {
        exam = exams.find(e => {
          const examStudentName = e.students?.name || '';
          return normalizeName(examStudentName) === normalizedName;
        });
      }
      
      // Get exam_id and subject_code for grouping key
      const examIdForGrouping = exam?.id || violationExamId || null;
      const subjectCodeForGrouping = exam?.exam_templates?.subject_code || exam?.subject_code || subjectCode || 'no_subject';
      
      // CRITICAL: Use timestamp to identify different exam sessions
      // ALWAYS use date-based grouping to separate different exam days, even if exam_id exists
      // This ensures violations from different dates are NEVER merged, even if they have the same exam_id
      let sessionIdentifier: string;
      if (violation.timestamp) {
        try {
          const violationDate = new Date(violation.timestamp);
          const dateKey = violationDate.toISOString().split('T')[0]; // YYYY-MM-DD
          
          if (examIdForGrouping) {
            // If we have exam_id, combine it with date to ensure different dates are separate
            // Format: examId_YYYY-MM-DD
            sessionIdentifier = `${examIdForGrouping}_${dateKey}`;
          } else {
            // If no exam_id, use date-based grouping to separate different exam days
            // Format: date_YYYY-MM-DD
            sessionIdentifier = `date_${dateKey}`;
          }
        } catch (e) {
          // If date parsing fails, use exam_id only or fallback
          sessionIdentifier = examIdForGrouping || `time_${violation.timestamp?.substring(0, 10) || 'unknown'}`;
        }
      } else {
        // If no timestamp, use exam_id if available, otherwise unique identifier
        sessionIdentifier = examIdForGrouping || `unknown_${violation.id}`;
      }
      
      console.log(`🔍 Violation ${violation.id}: sessionIdentifier = ${sessionIdentifier} (exam_id: ${examIdForGrouping}, date: ${violation.timestamp ? new Date(violation.timestamp).toISOString().split('T')[0] : 'no date'})`);
      
      // CRITICAL: Create a key that includes exam_id (or date-based session) and subject_code to keep different exam sessions separate
      // This ensures violations from different exam sessions are NEVER merged
      const mapKey = `${normalizedName}_${studentId}_${sessionIdentifier}_${subjectCodeForGrouping}`;
      
      if (!studentMap[mapKey]) {
        // Determine the best student ID to use
        let bestStudentId = studentId;
        let bestId = studentId;
        
        if (exam) {
          bestStudentId = exam.students?.student_id || exam.student_id || studentId;
          bestId = exam.students?.id || exam.id || studentId;
        } else {
          // Try to find student in students table by name
          // Note: We don't have direct access to students table here,
          // but we can use the student_id from violation if it's a valid UUID
          if (studentId && studentId.length > 20) {
            bestId = studentId; // Likely a UUID
          }
        }
        
        // Extract subject name with priority: exam template > exam > violation details
        let finalSubjectName = 'N/A';
        if (exam?.exam_templates?.subject_name) {
          finalSubjectName = exam.exam_templates.subject_name;
        } else if (exam?.subject_name) {
          finalSubjectName = exam.subject_name;
        } else if ((violation.details as any)?.subject_name) {
          finalSubjectName = (violation.details as any).subject_name;
        }
        
        // Extract subject code with priority: exam template > exam > violation details
        let finalSubjectCode = subjectCodeForGrouping !== 'no_subject' ? subjectCodeForGrouping : 'N/A';
        if (exam?.exam_templates?.subject_code) {
          finalSubjectCode = exam.exam_templates.subject_code;
        } else if (exam?.subject_code) {
          finalSubjectCode = exam.subject_code;
        } else if (subjectCode && subjectCode !== 'no_subject') {
          finalSubjectCode = subjectCode;
        }
        
        // Get roll_no from violation details, exam, or students map
        const violationDetails = violation.details as any;
        const studentRollNoMap = (window as any).studentRollNoMap as Map<string, string> | undefined;
        
        let rollNo = violationDetails?.roll_no || exam?.students?.roll_no;
        
        // If still not found, try to get from students map using student_id
        if ((!rollNo || rollNo === 'UNKNOWN' || rollNo === 'N/A') && studentRollNoMap) {
          if (bestStudentId && bestStudentId !== 'unknown') {
            rollNo = studentRollNoMap.get(bestStudentId) || studentRollNoMap.get(bestId) || rollNo;
          }
          // Also try with violation student_id
          const vStudentId = violation.student_id || violationDetails?.student_id;
          if ((!rollNo || rollNo === 'UNKNOWN' || rollNo === 'N/A') && vStudentId) {
            rollNo = studentRollNoMap.get(vStudentId) || rollNo;
          }
        }
        
        // Fallback to N/A if still not found
        if (!rollNo || rollNo === 'UNKNOWN') {
          rollNo = 'N/A';
        }
        
        studentMap[mapKey] = {
          name: exam?.students?.name || studentName,
          studentId: bestStudentId,
          rollNo: rollNo, // Store roll_no for display
          id: bestId, // Use student UUID or exam id
          examId: examIdForGrouping || exam?.id || null, // Store exam id for View Report navigation
          sessionIdentifier: sessionIdentifier, // Store session identifier for grouping (exam_id or date-based)
          violationCount: 0,
          violationTypes: [],
          violations: [],
          subjectName: finalSubjectName,
          subjectCode: finalSubjectCode,
        };
      }
      
      studentMap[mapKey].violationCount++;
      if (!studentMap[mapKey].violationTypes.includes(violation.violation_type)) {
        studentMap[mapKey].violationTypes.push(violation.violation_type);
      }
      studentMap[mapKey].violations.push(violation);
    });

    // Second pass: Only merge students with same name AND same exam session
    // Use sessionIdentifier (exam_id or date-based) to keep different exam sessions separate
    const mergedMap: { [key: string]: any } = {};
    Object.values(studentMap).forEach((student: any) => {
      const normalizedName = normalizeName(student.name);
      // CRITICAL: Include sessionIdentifier (exam_id or date) and subject_code in the merge key
      // This keeps different exam sessions separate even if they have the same student name
      const sessionId = student.sessionIdentifier || student.examId || 'no_exam';
      const mergeKey = `${normalizedName}_${sessionId}_${student.subjectCode || 'no_subject'}`;
      
      if (!mergedMap[mergeKey]) {
        mergedMap[mergeKey] = { ...student };
      } else {
        // Only merge if they're from the same exam session (same sessionIdentifier and subject_code)
        if (student.sessionIdentifier === mergedMap[mergeKey].sessionIdentifier && 
            student.subjectCode === mergedMap[mergeKey].subjectCode) {
          // Merge violations and types
          mergedMap[mergeKey].violations = [
            ...mergedMap[mergeKey].violations,
            ...student.violations
          ];
          mergedMap[mergeKey].violationCount += student.violationCount;
          student.violationTypes.forEach((type: string) => {
            if (!mergedMap[mergeKey].violationTypes.includes(type)) {
              mergedMap[mergeKey].violationTypes.push(type);
            }
          });
          
          // Prefer exam data if available (prioritize the one with examId)
          if (student.examId && !mergedMap[mergeKey].examId) {
            mergedMap[mergeKey].examId = student.examId;
            mergedMap[mergeKey].id = student.id;
            mergedMap[mergeKey].studentId = student.studentId;
            mergedMap[mergeKey].subjectName = student.subjectName;
            mergedMap[mergeKey].subjectCode = student.subjectCode;
          } else if (student.subjectCode && student.subjectCode !== 'N/A' && mergedMap[mergeKey].subjectCode === 'N/A') {
            // Update subject info if we have better data
            mergedMap[mergeKey].subjectName = student.subjectName;
            mergedMap[mergeKey].subjectCode = student.subjectCode;
          } else if (student.subjectName && student.subjectName !== 'N/A' && mergedMap[mergeKey].subjectName === 'N/A') {
            // Update subject name if we have better data
            mergedMap[mergeKey].subjectName = student.subjectName;
          }
        } else {
          // Different exam session - create separate entry
          // Use a unique key that includes sessionIdentifier to keep them separate
          const uniqueKey = `${mergeKey}_${student.sessionIdentifier || student.examId || Date.now()}`;
          mergedMap[uniqueKey] = { ...student };
        }
      }
    });

    // Sort violations by timestamp (most recent first)
    Object.values(mergedMap).forEach((student: any) => {
      student.violations.sort((a: any, b: any) => {
        const timeA = new Date(a.timestamp || 0).getTime();
        const timeB = new Date(b.timestamp || 0).getTime();
        return timeB - timeA;
      });
    });

    // Filter out entries with no violations (shouldn't happen, but safety check)
    const validStudents = Object.values(mergedMap).filter((student: any) => 
      student.violations && student.violations.length > 0
    );

    setStudentsWithViolations(validStudents);
  };

  const buildCompletedStudents = (exams: any[], violations: any[]) => {
    // Map examId -> all violations for that exam
    const violationsByExam: Record<string, any[]> = {};
    violations.forEach((v) => {
      const key = v.exam_id;
      if (!key) return;
      if (!violationsByExam[key]) violationsByExam[key] = [];
      violationsByExam[key].push(v);
    });

    const normalizeName = (name: string) => (name || '').toLowerCase().trim();

    const completed = exams
      .filter((exam) => exam.status === 'completed')
      .map((exam) => {
        // Start with violations that are directly linked by exam_id
        const examViolations = violationsByExam[exam.id] || [];

        // Also include violations that match this student by name/student_id,
        // even if exam_id is missing or incorrect (common for some detectors)
        const examStudentName = normalizeName(exam.students?.name || '');
        const examStudentId = exam.students?.student_id || exam.student_id || '';
        const examSubjectCode =
          exam.exam_templates?.subject_code || exam.subject_code || '';

        const extraViolations = violations.filter((v) => {
          // Skip ones already linked via exam_id
          if (v.exam_id === exam.id) return false;

          const vDetails = v.details as any;
          const vStudentId = v.student_id || vDetails?.student_id || '';
          const vStudentName = normalizeName(
            vDetails?.student_name || (v as any).student_name || ''
          );
          const vSubjectCode = vDetails?.subject_code || '';

          // Must match by name or student_id
          const matchesStudent =
            (!!examStudentName && vStudentName === examStudentName) ||
            (!!examStudentId && vStudentId === examStudentId);

          if (!matchesStudent) return false;

          // If both sides have subject codes, require them to match
          if (examSubjectCode && vSubjectCode && examSubjectCode !== vSubjectCode) {
            return false;
          }

          return true;
        });

        const mergedViolations = [...examViolations, ...extraViolations];

        const violationTypes = Array.from(
          new Set(mergedViolations.map((v) => v.violation_type))
        );

        const totalScore = exam.total_score ?? null;
        const maxScore = exam.max_score ?? null;
        let examScore: {
          total_score: number;
          max_score: number;
          percentage: number;
          grade_letter: string;
        } | undefined;

        if (totalScore !== null && maxScore && maxScore > 0) {
          const percentage = Math.round((totalScore / maxScore) * 100);
          // Same grading scale as StudentReport.tsx
          let grade = 'F';
          if (percentage >= 90) grade = 'A+';
          else if (percentage >= 85) grade = 'A';
          else if (percentage >= 80) grade = 'A-';
          else if (percentage >= 75) grade = 'B+';
          else if (percentage >= 70) grade = 'B';
          else if (percentage >= 65) grade = 'B-';
          else if (percentage >= 60) grade = 'C+';
          else if (percentage >= 55) grade = 'C';
          else if (percentage >= 50) grade = 'C-';
          else if (percentage >= 40) grade = 'D';

          examScore = {
            total_score: totalScore,
            max_score: maxScore,
            percentage,
            grade_letter: grade,
          };
        }

        return {
          examId: exam.id,
          // UUID or internal id for linking to StudentReport
          studentUuid: exam.students?.id || exam.student_id || exam.id,
          // Human-readable ID (roll number / college id)
          studentIdentifier:
            exam.students?.roll_no || exam.students?.student_id || exam.student_id || 'N/A',
          name: exam.students?.name || 'Unknown Student',
          subjectName:
            exam.exam_templates?.subject_name || exam.subject_name || 'N/A',
          subjectCode:
            exam.exam_templates?.subject_code || exam.subject_code || 'N/A',
          startedAt: exam.started_at,
          completedAt: exam.completed_at,
          graded: exam.graded,
          examScore,
          faceImageUrl: exam.students?.face_image_url || null,
          violationCount: mergedViolations.length,
          violationTypes,
          violations: mergedViolations,
          normalizedName: normalizeName(exam.students?.name || ''),
        };
      })
      .sort((a, b) => {
        const timeA = new Date(a.completedAt || 0).getTime();
        const timeB = new Date(b.completedAt || 0).getTime();
        return timeB - timeA;
      });

    setCompletedStudents(completed);
  };

  const handleLogout = async () => {
    try {
      await supabase.auth.signOut({ scope: 'global' });
    } catch (error) {
      console.error('Error signing out:', error);
    } finally {
      sessionStorage.removeItem('adminAuth');
      sessionStorage.removeItem('adminName');
      sessionStorage.removeItem('adminOAuthPending');
      toast.success("Logged out");
      navigate('/admin/login');
    }
  };

  const handleExportCSV = async (student: any) => {
    try {
      const csvContent = await pdfGenerator.exportToCSV(student.violations);
      const blob = new Blob([csvContent], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      
      // Use actual student name from violations if available
      const actualStudentName = student.violations?.[0]?.details?.student_name || 
                               student.violations?.[0]?.student_name || 
                               student.name || 
                               'Unknown_Student';
      const sanitizedName = actualStudentName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
      
      a.href = url;
      a.download = `${sanitizedName}_violations.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success("CSV exported");
    } catch (error) {
      console.error('Error exporting CSV:', error);
      toast.error("Failed to export CSV");
    }
  };

  const handleGenerateReport = async (student: any) => {
    try {
      toast.info("Generating PDF report...");
      // Ensure we use the correct student name from violations if available
      const actualStudentName = student.violations?.[0]?.details?.student_name || 
                               student.violations?.[0]?.student_name || 
                               student.name || 
                               'Unknown Student';
     
      // Try to find a matching exam session for score + face image
      const normalizeName = (name: string) => (name || '').toLowerCase().trim();
      let exam = examSessions.find(e => e.id === student.examId);
      if (!exam) {
        exam = examSessions.find(e =>
          e.student_id === student.studentId ||
          e.students?.student_id === student.studentId ||
          normalizeName(e.students?.name || '') === normalizeName(student.name)
        );
      }

      let examScore: { total_score: number; max_score: number; percentage: number; grade_letter: string } | undefined;
      let faceImageUrl: string | undefined;

      if (exam) {
        const totalScore = exam.total_score ?? null;
        const maxScore = exam.max_score ?? null;
        if (totalScore !== null && maxScore && maxScore > 0) {
          const percentage = Math.round((totalScore / maxScore) * 100);
          let grade = 'F';
          if (percentage >= 90) grade = 'A+';
          else if (percentage >= 85) grade = 'A';
          else if (percentage >= 80) grade = 'A-';
          else if (percentage >= 75) grade = 'B+';
          else if (percentage >= 70) grade = 'B';
          else if (percentage >= 65) grade = 'B-';
          else if (percentage >= 60) grade = 'C+';
          else if (percentage >= 55) grade = 'C';
          else if (percentage >= 50) grade = 'C-';
          else if (percentage >= 40) grade = 'D';

          examScore = {
            total_score: totalScore,
            max_score: maxScore,
            percentage,
            grade_letter: grade,
          };
        }
        faceImageUrl = exam.students?.face_image_url || undefined;
      }

      const pdfUrl = await pdfGenerator.generateStudentReport(
        actualStudentName,
        student.studentId,
        student.violations,
        student.subjectName,
        student.subjectCode,
        examScore,
        faceImageUrl,
        student.rollNo
      );
      
      window.open(pdfUrl, '_blank');
      toast.success("Report generated and saved to Supabase");
    } catch (error) {
      console.error('Error generating report:', error);
      toast.error("Failed to generate report");
    }
  };

  const handleExportAllCSV = async () => {
    try {
      const csvContent = await pdfGenerator.exportToCSV(violations);
      const blob = new Blob([csvContent], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `all_violations_${Date.now()}.csv`;
      a.click();
      toast.success("CSV exported");
    } catch (error) {
      toast.error("Failed to export");
    }
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const getViolationTypeIcon = (type: string) => {
    const icons: Record<string, string> = {
      'phone_detected': '📱',
      'book_detected': '📚',
      'multiple_faces': '👥',
      'multiple_person': '👥',
      'no_person': '❌',
      'object_detected': '📦',
      'looking_away': '👀',
      'eye_movement': '👁️',
      'excessive_noise': '🔊',
      'audio_violation': '🔊',
      'audio_noise': '🔊',
      'noise_detected': '🔊',
      'tab_switch': '🗂️',
      'copy_paste': '📋',
      'window_blur': '💤'
    };
    return icons[type] || '⚠️';
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center">
              <Shield className="w-7 h-7 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Admin Dashboard</h1>
              <p className="text-sm text-muted-foreground">Real-time Exam Monitoring</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="default" size="sm" onClick={() => navigate('/admin/analytics')}>
              <Activity className="w-4 h-4 mr-2" />
              Analytics
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate('/admin/monitor')}>
              <Monitor className="w-4 h-4 mr-2" />
              Live Monitor
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate('/admin/subjects')}>
              <BookOpen className="w-4 h-4 mr-2" />
              Subjects
            </Button>
            <Button variant="outline" size="sm" onClick={loadDashboardData}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={handleExportAllCSV}>
              <Download className="w-4 h-4 mr-2" />
              Export CSV
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate('/admin/upload-template')}>
              <Upload className="w-4 h-4 mr-2" />
              Upload Template
            </Button>
            <Button variant="outline" size="sm" onClick={handleLogout}>
              <LogOut className="w-4 h-4 mr-2" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Sessions</p>
                  <p className="text-3xl font-bold">{stats.totalSessions}</p>
                </div>
                <Activity className="w-8 h-8 text-primary" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Active Now</p>
                  <p className="text-3xl font-bold text-green-600">{stats.activeNow}</p>
                </div>
                <Users className="w-8 h-8 text-green-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Completed</p>
                  <p className="text-3xl font-bold">{stats.completed}</p>
                </div>
                <Shield className="w-8 h-8 text-primary" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Violations</p>
                  <p className="text-3xl font-bold text-red-600">{stats.totalViolations}</p>
                </div>
                <AlertTriangle className="w-8 h-8 text-red-600" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div>
                <p className="text-sm text-muted-foreground">Avg Violations/Student</p>
                <p className="text-3xl font-bold text-orange-600">{stats.avgViolationsPerStudent}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div>
                <p className="text-sm text-muted-foreground">Avg Exam Duration</p>
                <p className="text-3xl font-bold">{stats.avgExamDuration} min</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div>
                <p className="text-sm text-muted-foreground">Total Students</p>
                <p className="text-3xl font-bold text-primary">{stats.totalStudents}</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Violations Over Time Chart */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <h2 className="text-xl font-bold mb-6">Violations Over Time</h2>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" />
                <YAxis />
                <Tooltip />
                <Line 
                  type="monotone" 
                  dataKey="violations" 
                  stroke="#ef4444" 
                  strokeWidth={2} 
                  dot={{ r: 4 }} 
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Recent Violation Evidence Gallery */}
        <Card className="mb-8">
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <Eye className="w-5 h-5" />
                <h2 className="text-xl font-bold">Recent Violation Evidence Gallery</h2>
                <Badge variant="secondary">{violations.filter(v => v.image_url).length} Images</Badge>
              </div>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {violations
                .filter(v => v.image_url)
                .slice(0, 8)
                .map((violation) => (
                  <div key={violation.id} className="relative group">
                    <div className="aspect-video rounded-lg overflow-hidden border-2 border-border hover:border-red-500 transition-colors">
                      <img 
                        src={violation.image_url} 
                        alt={violation.violation_type}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          e.currentTarget.src = '/placeholder.svg';
                        }}
                      />
                    </div>
                    <div className="absolute top-2 left-2">
                      <Badge variant="destructive" className="text-xs">
                        {getViolationTypeIcon(violation.violation_type)} {violation.violation_type.replace(/_/g, ' ')}
                      </Badge>
                    </div>
                    <div className="mt-2">
                      <p className="text-xs font-medium">
                        {(violation.details as any)?.student_name || 
                         (violation as any).student_name || 
                         (violation.exam_id ? examSessions.find(e => e.id === violation.exam_id)?.students?.name : null) ||
                         'Unknown Student'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(violation.timestamp)}
                      </p>
                    </div>
                  </div>
                ))}
            </div>

            {violations.filter(v => v.image_url).length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                No violation evidence images found
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Students with Violations */}
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center gap-2 mb-6">
                  <Users className="w-5 h-5" />
                  <h2 className="text-xl font-bold">Students with Violations</h2>
                  <Badge variant="destructive">{studentsWithViolations.length} Students</Badge>
                </div>

                <div className="space-y-4">
                  {studentsWithViolations.map((student) => (
                    <div key={student.id} className="border rounded-lg p-4">
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <h3 className="font-bold">{student.name}</h3>
                          <p className="text-sm text-muted-foreground">Roll No: {student.rollNo || student.studentId || 'N/A'}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            <span className="font-medium">Subject:</span> {student.subjectName} ({student.subjectCode})
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="w-5 h-5 text-red-600" />
                          <span className="font-bold text-red-600">{student.violationCount} Violations</span>
                        </div>
                      </div>
                      
                      <div className="flex flex-wrap gap-2 mb-3">
                        {student.violationTypes.map((type: string) => (
                          <Badge key={type} variant="secondary" className="text-xs">
                            {getViolationTypeIcon(type)} {type.replace(/_/g, ' ')}
                          </Badge>
                        ))}
                      </div>

                      <div className="flex gap-2">
                        <Button 
                          size="sm" 
                          variant="default" 
                          onClick={() => {
                            // Helper function for name normalization
                            const normalizeName = (name: string) => (name || '').toLowerCase().trim();
                            
                            // Find exam by examId stored in student object, or by matching student_id/name
                            let examId = student.examId;
                            
                            if (!examId) {
                              // Try to find exam by student_id
                              examId = examSessions.find(e => 
                                e.student_id === student.studentId || 
                                e.students?.student_id === student.studentId ||
                                e.students?.id === student.id
                              )?.id;
                            }
                            
                            if (!examId) {
                              // Try to find by student name
                              examId = examSessions.find(e => 
                                normalizeName(e.students?.name || '') === normalizeName(student.name)
                              )?.id;
                            }
                            
                            if (!examId && student.subjectCode && student.subjectCode !== 'N/A') {
                              // Try to find by subject code and student name
                              examId = examSessions.find(e => {
                                const examSubjectCode = e.exam_templates?.subject_code || e.subject_code || '';
                                const examStudentName = e.students?.name || '';
                                return examSubjectCode === student.subjectCode && 
                                       normalizeName(examStudentName) === normalizeName(student.name);
                              })?.id;
                            }
                            
                            // Use student.id (UUID) if available, otherwise student.studentId
                            const studentIdForReport = student.id && student.id.length > 20 
                              ? student.id 
                              : (student.studentId !== 'unknown' ? student.studentId : student.id);
                            
                            navigate(`/admin/student-report?studentId=${studentIdForReport}&examId=${examId || ''}`);
                          }}
                        >
                          <Eye className="w-4 h-4 mr-1" />
                          View Report
                        </Button>
                        <Button 
                          size="sm" 
                          variant="outline" 
                          onClick={() => handleGenerateReport(student)}
                        >
                          <FileText className="w-4 h-4 mr-1" />
                          Generate PDF
                        </Button>
                        <Button 
                          size="sm" 
                          variant="outline" 
                          onClick={() => handleExportCSV(student)}
                        >
                          <Download className="w-4 h-4 mr-1" />
                          Export CSV
                        </Button>
                      </div>
                    </div>
                  ))}
                  {studentsWithViolations.length === 0 && (
                    <div className="text-center py-12 text-muted-foreground">
                      No violations detected yet
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center gap-2 mb-6">
                  <Shield className="w-5 h-5" />
                  <h2 className="text-xl font-bold">Completed Exams (All Students)</h2>
                  <Badge variant="secondary">{completedStudents.length} Students</Badge>
                </div>

                <div className="space-y-4">
                  {completedStudents.map((student) => (
                    <div key={student.examId} className="border rounded-lg p-4">
                      <div className="flex flex-wrap items-start justify-between gap-4 mb-3">
                        <div className="flex items-start gap-3">
                          {student.faceImageUrl && (
                            <div className="w-12 h-12 rounded-full overflow-hidden border">
                              <img
                                src={student.faceImageUrl}
                                alt={student.name}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  e.currentTarget.src = '/placeholder.svg';
                                }}
                              />
                            </div>
                          )}
                          <div>
                            <h3 className="font-bold">{student.name}</h3>
                            <p className="text-sm text-muted-foreground">
                              {student.studentIdentifier}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                              <span className="font-medium">Subject:</span>{" "}
                              {student.subjectName} ({student.subjectCode})
                            </p>
                            <p className="text-xs text-muted-foreground">
                              <span className="font-medium">Completed:</span>{" "}
                              {formatDate(student.completedAt)}
                            </p>
                          </div>
                        </div>
                        <div className="text-right space-y-1">
                          <Badge
                            variant={
                              student.violationCount === 0 ? "outline" : "destructive"
                            }
                          >
                            {student.violationCount === 0
                              ? "No Violations"
                              : `${student.violationCount} Violations`}
                          </Badge>
                          {student.examScore && (
                            <div className="text-sm">
                              <span className="font-medium">Score:</span>{" "}
                              {student.examScore.total_score} /{" "}
                              {student.examScore.max_score} (
                              {student.examScore.percentage}% •{" "}
                              {student.examScore.grade_letter})
                            </div>
                          )}
                        </div>
                      </div>

                      {student.violationTypes.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-3">
                          {student.violationTypes.map((type: string) => (
                            <Badge key={type} variant="secondary" className="text-xs">
                              {getViolationTypeIcon(type)}{" "}
                              {type.replace(/_/g, " ")}
                            </Badge>
                          ))}
                        </div>
                      )}

                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="default"
                          onClick={() => {
                            const studentIdForReport =
                              student.studentUuid &&
                              typeof student.studentUuid === "string" &&
                              student.studentUuid.length > 20
                                ? student.studentUuid
                                : student.studentIdentifier;

                            navigate(
                              `/admin/student-report?studentId=${studentIdForReport || ""}&examId=${student.examId || ""}`
                            );
                          }}
                        >
                          <Eye className="w-4 h-4 mr-1" />
                          View Report
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            try {
                              toast.info("Generating PDF report...");
                              const examScore = student.examScore;
                              const pdfUrl = await pdfGenerator.generateStudentReport(
                                student.name,
                                student.studentIdentifier,
                                student.violations,
                                student.subjectName,
                                student.subjectCode,
                                examScore,
                                student.faceImageUrl || undefined,
                                student.studentIdentifier // Use roll_no if available, fallback to studentIdentifier
                              );
                              window.open(pdfUrl, "_blank");
                              toast.success("Report generated and saved to Supabase");
                            } catch (error) {
                              console.error("Error generating report:", error);
                              toast.error("Failed to generate report");
                            }
                          }}
                        >
                          <FileText className="w-4 h-4 mr-1" />
                          Generate PDF
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleExportCSV(student)}
                        >
                          <Download className="w-4 h-4 mr-1" />
                          Download CSV
                        </Button>
                      </div>
                    </div>
                  ))}
                  {completedStudents.length === 0 && (
                    <div className="text-center py-12 text-muted-foreground">
                      No completed exams yet
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Recent Activity */}
          <div>
            <Card>
              <CardContent className="p-6">
                <h2 className="text-xl font-bold mb-6">Recent Activity</h2>
                <div className="space-y-3">
                  {violations.slice(0, 10).map((violation) => {
                    // Try multiple sources for student name
                    const vDetails = violation.details as any;
                    const studentName = vDetails?.student_name || 
                                      (violation as any).student_name || 
                                      (violation.exam_id ? examSessions.find(e => e.id === violation.exam_id)?.students?.name : null) ||
                                      'Unknown Student';
                    
                    return (
                      <div key={violation.id} className="text-sm border-l-2 border-red-500 pl-3 py-1">
                        <p className="font-medium">{studentName}</p>
                        <p className="text-muted-foreground">
                          {getViolationTypeIcon(violation.violation_type)} {violation.violation_type.replace(/_/g, ' ')}
                        </p>
                        <p className="text-xs text-muted-foreground">{formatDate(violation.timestamp)}</p>
                      </div>
                    );
                  })}
                  {violations.length === 0 && (
                    <p className="text-center text-muted-foreground py-8">No recent activity</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminDashboard;