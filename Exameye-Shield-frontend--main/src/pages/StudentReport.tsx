import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Download, FileText, Calendar, Clock, AlertTriangle, CheckCircle, XCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { pdfGenerator } from "@/utils/pdfGenerator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface StudentReportData {
  student: {
    id: string;
    name: string;
    email: string;
    student_id: string;
            roll_no?: string;
    face_image_url?: string;
  };
  exam: {
    id: string;
    subject_code: string;
    started_at: string;
    completed_at: string;
    status: string;
    subject_name: string;
    duration_minutes: number;
  };
  answers: Array<{
    question_number: number;
    question_text: string;
    question_type: string;
    answer: string;
    correct_answer?: string;
    points: number;
    options?: any;
  }>;
  violations: Array<{
    id: string;
    violation_type: string;
    severity: string;
    timestamp: string;
    image_url?: string;
    details?: any;
  }>;
}

const StudentReport = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const studentId = searchParams.get("studentId");
  const examId = searchParams.get("examId");
  
  const [reportData, setReportData] = useState<StudentReportData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const isAuthenticated = sessionStorage.getItem('adminAuth');
    if (!isAuthenticated) {
      toast.error("Please login as admin");
      navigate('/admin/login');
      return;
    }

    if (!studentId || !examId) {
      toast.error("Missing student or exam information");
      navigate('/admin/dashboard');
      return;
    }

    loadReportData();
  }, [studentId, examId, navigate]);

  const loadReportData = async () => {
    try {
      setLoading(true);

      // Helper to normalize names for matching
      const normalizeName = (name: string) => name?.toLowerCase().trim() || '';

      // FIRST: Try to get student directly from students table by UUID
      let studentData = null;
      let studentError = null;
      
      console.log('🔍 Looking for student with ID:', studentId);
      
      // Try direct lookup in students table first
      if (studentId && studentId.length > 20) {
        const { data, error } = await supabase
          .from('students')
          .select('*')
          .eq('id', studentId)
          .single();
        if (data && !error) {
          studentData = data;
          console.log('✅ Found student in students table:', studentData);
        } else {
          console.log('❌ Student not found in students table:', error);
        }
      }

      
      // If not found by UUID, try by student_id field
      if (!studentData && studentId) {
        const { data, error } = await supabase
          .from('students')
          .select('*')
          .eq('student_id', studentId)
          .maybeSingle();
        if (data && !error) {
          studentData = data;
          console.log('✅ Found student by student_id:', studentData);
        } else {
          console.log('❌ Student not found by student_id:', error);
        }
      }

      // If still not found, try to find student from violations
      if (!studentData) {
        // Try multiple queries to find student from violations
        let violationData = null;
        
        // Try by student_id
        if (studentId) {
          const { data } = await supabase
            .from('violations')
            .select('student_id, details, exam_id')
            .eq('student_id', studentId)
            .limit(1)
            .maybeSingle();
          violationData = data;
        }
        
        // Try by student name in details
        if (!violationData && studentId) {
          const { data } = await supabase
            .from('violations')
            .select('student_id, details, exam_id')
            .ilike('details->>student_name', `%${studentId}%`)
            .limit(1)
            .maybeSingle();
          if (data) violationData = data;
        }
        
        // Try by any violation with matching student_id or name
        if (!violationData) {
          const { data } = await supabase
            .from('violations')
            .select('student_id, details, exam_id')
            .order('timestamp', { ascending: false })
            .limit(50);
          
          if (data) {
            violationData = data.find(v => {
              const vStudentId = v.student_id || (v.details as any)?.student_id || '';
              const vStudentName = (v.details as any)?.student_name || '';
              return vStudentId === studentId || 
                     normalizeName(vStudentName) === normalizeName(studentId) ||
                     vStudentId.toString().includes(studentId) ||
                     studentId.toString().includes(vStudentId);
            });
          }
        }
        
        if (violationData) {
          // Get the actual student name from violation details
          const studentName = violationData.details?.student_name || violationData.student_name || 'Unknown Student';
          studentData = {
            id: violationData.student_id || studentId || 'unknown',
            name: studentName,
            email: '',
            student_id: violationData.student_id || studentId || 'N/A',
          };
        }
      }

      // CRITICAL FIX: If still no student data, get name from violations but DON'T use fallback names
      if (!studentData) {
        console.log('⚠️ No student found in database, checking violations for actual name...');
        
        // Get violations first to extract real student name
        const { data: allViolations } = await supabase
          .from('violations')
          .select('*')
          .or(`student_id.eq.${studentId},details->>student_id.eq.${studentId}`)
          .limit(1);
        
        let actualStudentName = 'Unknown Student';
        let actualStudentId = studentId || 'N/A';
        let actualRollNo: string | undefined = undefined;
        
        if (allViolations && allViolations.length > 0) {
          const violation = allViolations[0];
          const vDetails = violation.details as any;
          actualStudentName = vDetails?.student_name || (violation as any).student_name || 'Unknown Student';
          actualStudentId = violation.student_id || vDetails?.student_id || studentId || 'N/A';
          actualRollNo = vDetails?.roll_no;
          console.log('✅ Extracted from violations:', { actualStudentName, actualStudentId, actualRollNo });
        }
        
        studentData = {
          id: studentId || 'unknown',
          name: actualStudentName,
          email: '',
          student_id: actualStudentId,
          roll_no: actualRollNo,
        };
      }

      // Fetch exam info - try by examId if provided, otherwise find by student
      let examData = null;
      let examError = null;
      
      if (examId && examId.trim() !== '') {
        const { data, error } = await supabase
          .from('exams')
          .select(`
            *,
            students (
              id,
              name,
              email,
              student_id,
              roll_no,
              face_image_url
            ),
            exam_templates (
              subject_name,
              duration_minutes
            )
          `)
          .eq('id', examId)
          .maybeSingle();
        examData = data;
        examError = error;
        
        // CRITICAL FIX: If exam has student data, use it to override studentData
        // This ensures we use the correct student from the exam record
        if (examData && examData.students) {
          console.log('✅ Found student from exam record:', examData.students);
          studentData = {
            id: examData.students.id || examData.student_id || studentId || 'unknown',
            name: examData.students.name || studentData?.name || 'Unknown Student',
            email: examData.students.email || studentData?.email || '',
            student_id: examData.students.student_id || examData.students.id || studentData?.student_id || 'N/A',
            roll_no: examData.students.roll_no || studentData?.roll_no || 'N/A',
            face_image_url: examData.students.face_image_url || studentData?.face_image_url,
          };
          console.log('✅ Updated studentData from exam:', studentData);
        }
      }
      
      // If no exam found, try to find exam by student_id or student name
      if (!examData) {
        const { data: examsData } = await supabase
          .from('exams')
          .select(`
            *,
            students (
              name,
              student_id,
              roll_no,
              face_image_url
            ),
            exam_templates (
              subject_name,
              duration_minutes
            )
          `)
          .or(`student_id.eq.${studentData.student_id || studentData.id},students.student_id.eq.${studentData.student_id || studentData.id}`)
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        
        if (examsData) {
          examData = examsData;
        } else {
          // Try by student name
          // Wrap examsByName fetch in try/catch in case roll_no column doesn't exist yet
          try {
          const { data: examsByName } = await supabase
            .from('exams')
            .select(`
              *,
              students (
                name,
                  student_id,
                  roll_no
              ),
              exam_templates (
                subject_name,
                duration_minutes
              )
            `)
            .order('started_at', { ascending: false })
            .limit(10);
          
          if (examsByName) {
              examData = examsByName
                .filter((e: any) => !!e.students)
                .find((e: any) =>
              normalizeName(e.students?.name || '') === normalizeName(studentData.name)
            ) || null;
            }
          } catch (e) {
            console.warn('Could not fetch exams by name with roll_no (column may not exist yet):', e);
          }
        }
      }

      // Fetch answers with questions - only if exam exists
      let answersWithQuestions: any[] = [];
      if (examData) {
        const { data: answersData, error: answersError } = await supabase
          .from('exam_answers')
          .select('*')
          .eq('exam_id', examData.id)
          .order('question_number');

        if (!answersError && answersData) {
          // Fetch questions to join with answers - only if exam_template_id exists
          let questionsData = null;
          if (examData.exam_template_id) {
            const { data, error: questionsError } = await supabase
              .from('exam_questions')
              .select('*')
              .eq('exam_template_id', examData.exam_template_id)
              .order('question_number');

            if (!questionsError) {
              questionsData = data;
            }
          }

          // Merge answers with questions
          answersWithQuestions = (answersData || []).map(answer => {
            const question = questionsData?.find(q => q.question_number === answer.question_number);
            return {
              question_number: answer.question_number,
              question_text: question?.question_text || 'Question not found',
              question_type: question?.question_type || 'short_answer',
              answer: answer.answer || 'Not answered',
              correct_answer: question?.correct_answer,
              points: question?.points || 0,
              options: question?.options,
            };
          });
        }
      }

      // CRITICAL FIX: Apply same logic as AdminDashboard.buildCompletedStudents
      // Strategy: Get violations directly linked by exam_id, then merge with violations
      // that match by student name/ID even if exam_id is missing or incorrect
      let violationsData: any[] = [];
      
      console.log('🔍 Starting comprehensive violation fetch (AdminDashboard logic)...');
      console.log('📋 Search parameters:', {
        examId: examData?.id || examId,
        studentId: studentData?.id || studentId,
        studentName: studentData?.name,
        studentIdFromParams: studentId
      });
        
      // STEP 1: Map violations by exam_id (same as AdminDashboard)
      const violationsByExam: Record<string, any[]> = {};
      if (examData?.id || examId) {
        const targetExamId = examData?.id || examId;
        console.log(`🔍 Query 1: Fetching violations directly linked by exam_id: ${targetExamId}`);
        
        const { data: examViolations, error: examError } = await supabase
          .from('violations')
            .select('*')
          .eq('exam_id', targetExamId)
            .order('timestamp', { ascending: false })
          .limit(500);
        
        if (examError) {
          console.error('❌ Error fetching exam violations:', examError);
        } else {
          console.log(`✅ Query 1: Found ${examViolations?.length || 0} violations directly linked by exam_id`);
          
          if (examViolations && examViolations.length > 0) {
            // Log all violation types found
            const violationTypes = examViolations.map(v => v.violation_type);
            const typeCounts = violationTypes.reduce((acc, type) => {
              acc[type] = (acc[type] || 0) + 1;
              return acc;
            }, {} as Record<string, number>);
            console.log('📊 Violation types in exam (direct links):', typeCounts);
            
            violationsByExam[targetExamId] = examViolations;
          }
        }
      }
      
      // STEP 2: Get ALL violations from database to find extra ones (same as AdminDashboard)
      console.log('🔍 Query 2: Fetching ALL violations to find extra matches...');
      const { data: allViolations, error: allViolationsError } = await supabase
        .from('violations')
              .select('*')
              .order('timestamp', { ascending: false })
        .limit(1000);
      
      if (allViolationsError) {
        console.error('❌ Error fetching all violations:', allViolationsError);
      } else {
        console.log(`✅ Query 2: Found ${allViolations?.length || 0} total violations in database`);
      }
      
      // STEP 3: Apply AdminDashboard.buildCompletedStudents logic
      // Start with violations directly linked by exam_id
      const targetExamId = examData?.id || examId;
      const examViolations = targetExamId ? (violationsByExam[targetExamId] || []) : [];
      
      // Get student identifiers from exam/student data (same as AdminDashboard)
      const examStudentName = normalizeName(examData?.students?.name || studentData?.name || '');
      const examStudentId = examData?.students?.student_id || examData?.student_id || studentData?.student_id || studentData?.id || studentId || '';
      const examSubjectCode = examData?.exam_templates?.subject_code || examData?.subject_code || '';
      
      console.log('📋 Student identifiers for matching:', {
        examStudentName,
        examStudentId,
        examSubjectCode,
        targetExamId,
        examStatus: examData?.status
      });
      
      // If no violations found by exam_id, try to find violations by student_id directly
      // This handles cases where exam is "not_started" but violations exist
      if (examViolations.length === 0 && (studentData?.id || studentId)) {
        console.log('🔍 No violations found by exam_id, trying by student_id...');
        const studentIdsToSearch = [
          studentData?.id,
          studentData?.student_id,
          studentId
        ].filter(id => id && id !== 'unknown' && id !== 'N/A');
        
        for (const sid of studentIdsToSearch) {
          if (!sid) continue;
          
          const { data: studentViolations } = await supabase
          .from('violations')
          .select('*')
            .or(`student_id.eq.${sid},details->>student_id.eq.${sid}`)
            .order('timestamp', { ascending: false })
            .limit(200);
          
          if (studentViolations && studentViolations.length > 0) {
            console.log(`✅ Found ${studentViolations.length} violations by student_id ${sid}`);
            // Filter to only include violations that match the exam_id if provided, or match subject code
            const filtered = studentViolations.filter(v => {
              // If we have target exam_id, prefer violations with that exam_id
              if (targetExamId && v.exam_id === targetExamId) return true;
              // If no target exam_id or violation has no exam_id, include if subject code matches
              if (!targetExamId || !v.exam_id) {
                const vSubjectCode = String((v.details as any)?.subject_code || '').trim();
                return !examSubjectCode || !vSubjectCode || vSubjectCode === examSubjectCode;
              }
              return false;
          });
            
            if (filtered.length > 0) {
              violationsByExam[targetExamId || 'student_match'] = filtered;
              console.log(`✅ Using ${filtered.length} violations matched by student_id`);
            }
            break; // Use first successful match
          }
        }
      }
      
      // Update examViolations after potential student_id lookup
      const finalExamViolations = targetExamId ? (violationsByExam[targetExamId] || []) : (violationsByExam['student_match'] || []);
      
      // Find extra violations that match by student name/student_id
      // Priority: If exam_id matches, use it. Otherwise, match by student + subject code + date proximity
      const extraViolations = (allViolations || []).filter((v) => {
        // Skip ones already linked via exam_id
        if (targetExamId && v.exam_id === targetExamId) return false;
        
        // Extract violation student info
        const vStudentId = String(v.student_id || (v.details as any)?.student_id || '').trim();
        const vStudentName = normalizeName(
          String((v.details as any)?.student_name || (v as any).student_name || '').trim()
        );
        const vSubjectCode = String((v.details as any)?.subject_code || '').trim();
        const vExamId = v.exam_id || '';
        
        // Must match by name OR student_id
        const matchesStudent =
          (!!examStudentName && vStudentName && vStudentName === examStudentName) ||
          (!!examStudentId && vStudentId && vStudentId === examStudentId);
        
        if (!matchesStudent) {
          return false;
        }
        
        // CRITICAL: If we have a target exam_id, prefer violations with that exact exam_id
        // But if violation has a different exam_id, only exclude if subject codes don't match
        if (targetExamId) {
          if (vExamId && vExamId !== targetExamId) {
            // Different exam_id - only include if subject codes match (might be same subject, different session)
            // But we want to show violations from the specific exam session, so exclude different exam_ids
            console.log(`⚠️ Excluding violation ${v.id}: different exam_id (violation: ${vExamId}, target: ${targetExamId})`);
            return false;
        }
      }
      
        // If both sides have subject codes, require them to match
        if (examSubjectCode && vSubjectCode && examSubjectCode !== vSubjectCode) {
          return false;
        }
        
        // CRITICAL: If exam has started_at, only include violations within the exam timeframe
        // AND from the same date (YYYY-MM-DD) to prevent merging different exam sessions
        if (examData?.started_at && v.timestamp) {
          try {
            const examStartTime = new Date(examData.started_at).getTime();
            const violationTime = new Date(v.timestamp).getTime();
            const examEndTime = examData.completed_at 
              ? new Date(examData.completed_at).getTime() 
              : examStartTime + (examData.duration_minutes || 120) * 60 * 1000; // Default 2 hours if no completion time
            
            // Check if violation is within exam timeframe
            const buffer = 15 * 60 * 1000; // 15 minutes in milliseconds
            const withinTimeframe = violationTime >= examStartTime - buffer && violationTime <= examEndTime + buffer;
            
            // Also check if violation is from the same date as exam
            const examDate = new Date(examData.started_at).toISOString().split('T')[0];
            const violationDate = new Date(v.timestamp).toISOString().split('T')[0];
            const sameDate = examDate === violationDate;
            
            if (!withinTimeframe || !sameDate) {
              console.log(`⚠️ Excluding violation ${v.id}: ${!withinTimeframe ? 'outside timeframe' : ''} ${!sameDate ? 'different date' : ''} (violation: ${v.timestamp}, exam: ${examData.started_at})`);
              return false;
            }
          } catch (e) {
            console.warn(`⚠️ Failed to parse dates for violation ${v.id}:`, e);
            return false;
          }
        } else if (!examData?.started_at && v.timestamp && targetExamId) {
          // If no exam start time but we have exam_id, exclude violations with different exam_id
          // This prevents merging violations from different exam sessions
          if (vExamId && vExamId !== targetExamId) {
            return false;
          }
        }
        // If no exam start time and no exam_id, still include violations if they match by student and subject_code
        // This handles cases where exam is "not_started" but violations exist
        
        return true;
      });
      
      console.log(`✅ Found ${extraViolations.length} extra violations matching by student name/ID`);
      if (extraViolations.length > 0) {
        const extraTypes = extraViolations.map(v => v.violation_type);
        const extraTypeCounts = extraTypes.reduce((acc, type) => {
          acc[type] = (acc[type] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        console.log('📊 Extra violation types:', extraTypeCounts);
      }
      
      // Merge violations (same as AdminDashboard - line 456)
      // Use finalExamViolations if available, otherwise use examViolations
      const violationsToMerge = finalExamViolations.length > 0 ? finalExamViolations : examViolations;
      const mergedViolations = [...violationsToMerge, ...extraViolations];
      
      // Remove duplicates by violation id
      const violationMap = new Map<string, any>();
      mergedViolations.forEach(v => {
              if (!violationMap.has(v.id)) {
                violationMap.set(v.id, v);
              }
            });
      
      // CRITICAL: Group violations by date to ensure different dates are kept separate
      // If exam has started_at, only include violations from the same date (YYYY-MM-DD)
      let finalViolations = Array.from(violationMap.values());
      
      if (examData?.started_at) {
        try {
          const examDate = new Date(examData.started_at);
          const examDateKey = examDate.toISOString().split('T')[0]; // YYYY-MM-DD
          
          console.log(`📅 Filtering violations by exam date: ${examDateKey}`);
          
          finalViolations = finalViolations.filter(v => {
            if (!v.timestamp) return false;
            
            try {
              const violationDate = new Date(v.timestamp);
              const violationDateKey = violationDate.toISOString().split('T')[0]; // YYYY-MM-DD
              
              // Only include violations from the same date as the exam
              if (violationDateKey !== examDateKey) {
                console.log(`⚠️ Excluding violation ${v.id}: different date (violation: ${violationDateKey}, exam: ${examDateKey})`);
                return false;
              }
              
              return true;
            } catch (e) {
              console.warn(`⚠️ Failed to parse violation date for ${v.id}:`, e);
              return false;
            }
          });
          
          console.log(`✅ After date filtering: ${finalViolations.length} violations from exam date ${examDateKey}`);
        } catch (e) {
          console.warn(`⚠️ Failed to parse exam date:`, e);
        }
      } else if (targetExamId) {
        // If no exam start time but we have exam_id, group violations by date
        // Find the most common date among violations and only keep those
        const dateGroups: Record<string, any[]> = {};
        finalViolations.forEach(v => {
          if (v.timestamp) {
            try {
              const violationDate = new Date(v.timestamp);
              const dateKey = violationDate.toISOString().split('T')[0];
              if (!dateGroups[dateKey]) dateGroups[dateKey] = [];
              dateGroups[dateKey].push(v);
            } catch (e) {
              // Skip violations with invalid dates
            }
          }
        });
        
        // Find the date with the most violations (likely the exam date)
        let maxDate = '';
        let maxCount = 0;
        Object.entries(dateGroups).forEach(([date, violations]) => {
          if (violations.length > maxCount) {
            maxCount = violations.length;
            maxDate = date;
          }
        });
        
        // Only keep violations from the most common date
        if (maxDate) {
          console.log(`📅 Grouping violations by date: using ${maxDate} (${maxCount} violations)`);
          finalViolations = dateGroups[maxDate];
        }
      }
      
      violationsData = finalViolations.sort((a, b) => {
        const timeA = new Date(a.timestamp || 0).getTime();
        const timeB = new Date(b.timestamp || 0).getTime();
        return timeB - timeA;
      });
      
      // Comprehensive logging
      console.log(`✅ Total violations found after merge: ${violationsData.length}`);
      const violationTypes = violationsData.map(v => v.violation_type);
      const typeCounts = violationTypes.reduce((acc, type) => {
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      console.log('📊 Final violation types:', typeCounts);
      console.log('📊 Violations with images:', violationsData.filter(v => v.image_url).length);
      console.log('📋 Breakdown:', {
        directlyLinked: examViolations.length,
        extraMatched: extraViolations.length,
        totalAfterMerge: violationsData.length
      });

      // CRITICAL FIX: Ensure we're using the correct student data
      // Priority: exam.students > studentData from lookup > filtered violations
      const finalStudentData = examData?.students ? {
        id: examData.students.id || studentData.id,
        name: examData.students.name || studentData.name,
        email: examData.students.email || studentData.email || '',
        student_id: examData.students.student_id || examData.students.id || studentData.student_id || 'N/A',
        roll_no: examData.students.roll_no || studentData.roll_no, // propagate roll number from exam or studentData
        face_image_url: examData.students.face_image_url || studentData?.face_image_url,
      } : {
        id: studentData.id,
        name: studentData.name,
        email: studentData.email || '',
        student_id: studentData.student_id || studentData.id || 'N/A',
        roll_no: studentData.roll_no, // keep roll number if already loaded
        face_image_url: studentData?.face_image_url,
      };
      
      // Only use violation name if we don't have a proper name AND the violation matches our student/exam
      let finalStudentName = finalStudentData.name;
      if ((!finalStudentName || finalStudentName === 'Unknown Student' || finalStudentName === studentId) && violationsData.length > 0) {
        // Only use violation name if it matches our student_id or exam_id
        const matchingViolation = violationsData.find(v => {
          const vStudentId = v.student_id || v.details?.student_id || '';
          const vExamId = v.exam_id || '';
          return (vStudentId === finalStudentData.id || vStudentId === finalStudentData.student_id) &&
                 (!examData?.id || vExamId === examData.id);
        });
        
        if (matchingViolation) {
          const violationName = matchingViolation.details?.student_name || matchingViolation.student_name;
          if (violationName && violationName !== 'Unknown Student' && violationName !== studentId) {
            finalStudentName = violationName;
            console.log('✅ Using student name from matching violation:', finalStudentName);
          }
        }
      }
      
      console.log('✅ Final student data being used:', { 
        name: finalStudentName, 
        id: finalStudentData.id, 
        student_id: finalStudentData.student_id,
        roll_no: finalStudentData.roll_no,
        email: finalStudentData.email,
      });
      
      setReportData({
        student: {
          id: finalStudentData.id,
          name: finalStudentName,
          email: finalStudentData.email || '',
          student_id: finalStudentData.student_id || finalStudentData.id || 'N/A',
          roll_no: finalStudentData.roll_no,
          face_image_url: finalStudentData.face_image_url,
        },
        exam: examData ? {
          id: examData.id,
          subject_code: examData.exam_templates?.subject_code || examData.subject_code || (violationsData[0]?.details as any)?.subject_code || 'N/A',
          started_at: examData.started_at || '',
          completed_at: examData.completed_at || '',
          status: examData.status || 'unknown',
          subject_name: examData.exam_templates?.subject_name || examData.subject_name || (violationsData[0]?.details as any)?.subject_name || (violationsData[0]?.details as any)?.subject_code || 'N/A',
          duration_minutes: examData.exam_templates?.duration_minutes || 0,
        } : {
          id: '',
          subject_code: 'N/A',
          started_at: '',
          completed_at: '',
          status: 'unknown',
          subject_name: 'N/A',
          duration_minutes: 0,
        },
        answers: answersWithQuestions,
        violations: violationsData,
      });

      setLoading(false);
    } catch (error) {
      console.error('Error loading report data:', error);
      
      // Try to at least show violations even if student/exam lookup failed
      try {
        // Try multiple ways to find violations
        let violationsData: any[] = [];
        
        // Try by studentId
        if (studentId) {
          const { data } = await supabase
            .from('violations')
            .select('*')
            .or(`student_id.eq.${studentId},details->>student_id.eq.${studentId}`)
            .order('timestamp', { ascending: false });
          if (data) violationsData = data;
        }
        
        // Try by student name in details
        if (violationsData.length === 0 && studentId) {
          const { data } = await supabase
            .from('violations')
            .select('*')
            .ilike('details->>student_name', `%${studentId}%`)
            .order('timestamp', { ascending: false })
            .limit(100);
          if (data) violationsData = data;
        }
        
        // Try by examId if provided
        if (violationsData.length === 0 && examId) {
          const { data } = await supabase
            .from('violations')
            .select('*')
            .eq('exam_id', examId)
            .order('timestamp', { ascending: false });
          if (data) violationsData = data;
        }
        
        if (violationsData && violationsData.length > 0) {
          const firstViolation = violationsData[0];
          const studentName = firstViolation.details?.student_name || 
                             firstViolation.student_name || 
                             'Unknown Student';
          
          // Try to get subject info from violation details
          const subjectName = firstViolation.details?.subject_name || 'N/A';
          const subjectCode = firstViolation.details?.subject_code || 'N/A';
          
          setReportData({
            student: {
              id: firstViolation.student_id || studentId || 'unknown',
              name: studentName,
              email: '',
              student_id: firstViolation.student_id || firstViolation.details?.student_id || studentId || 'N/A',
            },
            exam: {
              id: firstViolation.exam_id || examId || '',
              subject_code: subjectCode,
              started_at: '',
              completed_at: '',
              status: 'unknown',
              subject_name: subjectName,
              duration_minutes: 0,
            },
            answers: [],
            violations: violationsData,
          });
          
          toast.warning("Some data could not be loaded, but violations are shown.");
        } else {
          // No violations found either
          toast.error("No violations found for this student.");
        }
      } catch (fallbackError) {
        console.error('Fallback error:', fallbackError);
        toast.error("Failed to load any data. Please check the student ID and try again.");
      }
      
      setLoading(false);
    }
  };

  const forceRefreshStudentData = async () => {
    if (!studentId) return;
    
    try {
      console.log('🔄 Force refreshing student data for ID:', studentId);
      
      // Direct query to students table
      const { data: freshStudentData, error } = await supabase
        .from('students')
        .select('*')
        .eq('id', studentId)
        .single();
      
      if (freshStudentData && !error) {
        console.log('✅ Fresh student data:', freshStudentData);
        
        setReportData(prev => prev ? {
          ...prev,
          student: {
            ...prev.student,
            name: freshStudentData.name,
            email: freshStudentData.email || '',
            student_id: freshStudentData.student_id || freshStudentData.id
          }
        } : null);
        
        toast.success(`Student data refreshed: ${freshStudentData.name}`);
      } else {
        console.log('❌ Could not refresh student data:', error);
        toast.error('Could not refresh student data');
      }
    } catch (error) {
      console.error('Error refreshing student data:', error);
      toast.error('Failed to refresh student data');
    }
  };

  const handleDownloadPDF = async () => {
    if (!reportData) return;
    
    try {
      toast.info("Generating comprehensive PDF report...");
      const scoreData = calculateScore();
      const examScore = {
        total_score: scoreData.earnedPoints,
        max_score: scoreData.totalPoints,
        percentage: scoreData.percentage,
        grade_letter: scoreData.grade
      };
      
      // CRITICAL FIX: Always use the student name from reportData.student, not from violations
      // This ensures we use the correct student name that was properly filtered and matched
      const actualStudentName = reportData.student.name || 'Unknown Student';
      const actualStudentId = reportData.student.student_id || reportData.student.id || 'N/A';
      const actualStudentEmail = reportData.student.email || '';
      
      console.log('📄 Generating PDF with student data:', {
        name: actualStudentName,
        student_id: actualStudentId,
        email: actualStudentEmail
      });
      
      const pdfUrl = await pdfGenerator.generateStudentReport(
        actualStudentName,
        actualStudentId,
        reportData.violations,
        reportData.exam.subject_name,
        reportData.exam.subject_code,
        examScore,
        reportData.student.face_image_url,
        reportData.student.roll_no
      );
      
      window.open(pdfUrl, '_blank');
      toast.success("Report generated successfully");
    } catch (error) {
      console.error('Error generating PDF:', error);
      toast.error("Failed to generate PDF");
    }
  };

  const handleDownloadCSV = async () => {
    if (!reportData) return;
    
    try {
      const csvContent = await pdfGenerator.exportToCSV(reportData.violations);
      const blob = new Blob([csvContent], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      
      // Use actual student name from violations if available
      const actualStudentName = (reportData.violations?.[0]?.details as any)?.student_name || 
                               (reportData.violations?.[0] as any)?.student_name || 
                               reportData.student.name || 
                               'Unknown_Student';
      const sanitizedName = actualStudentName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
      
      a.href = url;
      a.download = `${sanitizedName}_violations_${Date.now()}.csv`;
      a.click();
      toast.success("CSV exported successfully");
    } catch (error) {
      console.error('Error exporting CSV:', error);
      toast.error("Failed to export CSV");
    }
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleString();
  };

  const formatViolationType = (type: string) => {
    const typeMap: Record<string, string> = {
      'looking_away': 'Looking Away',
      'eye_movement': 'Eye Movement',
      'multiple_person': 'Multiple Person',
      'multiple_faces': 'Multiple Person',
      'excessive_noise': 'Excessive Noise',
      'audio_violation': 'Audio Violation',
      'phone_detected': 'Phone Detected',
      'book_detected': 'Book Detected',
      'no_person': 'No Person',
      'tab_switch': 'Tab Switch',
      'copy_paste': 'Copy/Paste',
      'object_detected': 'Object Detected'
    };
    return typeMap[type] || type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  const calculateScore = () => {
    if (!reportData) return { correct: 0, total: 0, percentage: 0, grade: 'F' };
    
    let correct = 0;
    let totalPoints = 0;
    let earnedPoints = 0;
    
    reportData.answers.forEach(answer => {
      if (answer.question_type === 'mcq' && answer.correct_answer) {
        const points = answer.points || 1;
        totalPoints += points;
        
        // Case-insensitive comparison
        if (answer.answer?.trim().toLowerCase() === answer.correct_answer?.trim().toLowerCase()) {
          correct++;
          earnedPoints += points;
        }
      }
    });
    
    const total = reportData.answers.filter(a => a.question_type === 'mcq' && a.correct_answer).length;
    const percentage = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0;
    
    // Calculate letter grade
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
    
    return { correct, total, percentage, grade, earnedPoints, totalPoints };
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading report...</p>
        </div>
      </div>
    );
  }

  if (!reportData) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">No report data found</p>
          <Button onClick={() => navigate('/admin/dashboard')} className="mt-4">
            Back to Dashboard
          </Button>
        </div>
      </div>
    );
  }

  const score = calculateScore();

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate('/admin/dashboard')}>
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <div>
                <h1 className="text-xl font-bold">Student Report</h1>
                <p className="text-sm text-muted-foreground">{reportData.student.name}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={forceRefreshStudentData}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Refresh
              </Button>
              <Button variant="outline" size="sm" onClick={handleDownloadCSV}>
                <Download className="w-4 h-4 mr-2" />
                CSV
              </Button>
              <Button variant="default" size="sm" onClick={handleDownloadPDF}>
                <FileText className="w-4 h-4 mr-2" />
                PDF Report
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8 max-w-7xl">
        {/* Student & Exam Overview */}
        <div className="grid md:grid-cols-2 gap-6 mb-8">
          <Card>
            <CardHeader>
              <CardTitle>Student Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {reportData.student.face_image_url && (
                <div className="mb-4">
                  <p className="text-sm text-muted-foreground mb-2">Registration Photo</p>
                  <div className="w-32 h-32 rounded-lg overflow-hidden border-2 border-primary">
                    <img 
                      src={reportData.student.face_image_url}
                      alt="Student registration photo"
                      className="w-full h-full object-cover"
                    />
                  </div>
                </div>
              )}
              <div>
                <p className="text-sm text-muted-foreground">Name</p>
                <p className="font-medium">{reportData.student.name}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Roll Number</p>
                <p className="font-medium">
                  {reportData.student.roll_no || reportData.student.student_id || "N/A"}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Email</p>
                <p className="font-medium">{reportData.student.email}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Exam Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-sm text-muted-foreground">Subject</p>
                <p className="font-medium">{reportData.exam.subject_name}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Subject Code</p>
                <p className="font-medium">{reportData.exam.subject_code}</p>
              </div>
              <div className="flex items-center gap-4">
                <div>
                  <p className="text-sm text-muted-foreground flex items-center gap-1">
                    <Calendar className="w-3 h-3" /> Started
                  </p>
                  <p className="text-sm font-medium">{formatDate(reportData.exam.started_at)}</p>
                </div>
                {reportData.exam.completed_at && (
                  <div>
                    <p className="text-sm text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" /> Completed
                    </p>
                    <p className="text-sm font-medium">{formatDate(reportData.exam.completed_at)}</p>
                  </div>
                )}
              </div>
              <div>
                <Badge variant={reportData.exam.status === 'completed' ? 'default' : 'secondary'}>
                  {reportData.exam.status}
                </Badge>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Score Summary (for MCQ) */}
        {reportData.answers.some(a => a.question_type === 'mcq') && (
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>Score Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-8">
                <div className="text-center">
                  <div className="text-4xl font-bold text-primary">{score.percentage}%</div>
                  <div className="text-2xl font-bold text-secondary mt-1">{score.grade}</div>
                  <p className="text-sm text-muted-foreground">Overall Score</p>
                </div>
                <Separator orientation="vertical" className="h-20" />
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm">Points Earned</span>
                    <span className="font-bold text-success">{score.earnedPoints}/{score.totalPoints}</span>
                  </div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm">Correct Answers</span>
                    <span className="font-bold text-success">{score.correct}/{score.total}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Violations</span>
                    <span className="font-bold text-destructive">{reportData.violations.length}</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Answers Section */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Exam Answers</CardTitle>
          </CardHeader>
          <CardContent>
            {reportData.answers.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No answers submitted</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Q#</TableHead>
                    <TableHead>Question</TableHead>
                    <TableHead>Student Answer</TableHead>
                    <TableHead>Correct Answer</TableHead>
                    <TableHead className="w-20">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reportData.answers.map((answer) => {
                    const isCorrect = answer.question_type === 'mcq' && answer.correct_answer 
                      ? answer.answer?.trim().toLowerCase() === answer.correct_answer?.trim().toLowerCase()
                      : null;
                    
                    return (
                      <TableRow key={answer.question_number}>
                        <TableCell className="font-medium">{answer.question_number}</TableCell>
                        <TableCell>
                          <div className="max-w-md">
                            <p className="mb-2">{answer.question_text}</p>
                            {answer.question_type === 'mcq' && answer.options && (
                              <div className="text-xs text-muted-foreground space-y-1">
                                {Object.entries(answer.options).map(([key, value]) => (
                                  <div key={key} className="flex gap-2">
                                    <span className="font-medium">{key}:</span>
                                    <span>{value as string}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className={isCorrect === false ? 'text-destructive font-medium' : ''}>
                            {answer.answer || <span className="text-muted-foreground italic">Not answered</span>}
                          </span>
                        </TableCell>
                        <TableCell>
                          {answer.correct_answer || <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>
                          {isCorrect === true && <CheckCircle className="w-5 h-5 text-success" />}
                          {isCorrect === false && <XCircle className="w-5 h-5 text-destructive" />}
                          {isCorrect === null && <span className="text-muted-foreground text-xs">Manual</span>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Violations Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5" />
              Violations ({reportData.violations.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {reportData.violations.length === 0 ? (
              <div className="text-center py-8">
                <CheckCircle className="w-16 h-16 text-success mx-auto mb-4" />
                <p className="text-lg font-medium text-success">No violations detected</p>
                <p className="text-sm text-muted-foreground">This student had a clean exam session</p>
              </div>
            ) : (
              <div className="space-y-4">
                {reportData.violations.map((violation) => (
                  <div key={violation.id} className="border rounded-lg p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <Badge variant="destructive">{formatViolationType(violation.violation_type)}</Badge>
                          <Badge variant="outline">{violation.severity}</Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          <Clock className="w-3 h-3 inline mr-1" />
                          {formatDate(violation.timestamp)}
                        </p>
                        {violation.details?.message && (
                          <p className="text-sm mt-2">{violation.details.message}</p>
                        )}
                      </div>
                      {violation.image_url && (
                        <div className="ml-4 text-center">
                          <div className="text-xs text-muted-foreground mb-1 font-semibold">📷 Evidence Captured</div>
                          <img 
                            src={violation.image_url}
                            alt="Violation evidence"
                            className="w-32 h-24 object-cover rounded border-2 border-red-500 cursor-pointer hover:scale-105 transition-transform"
                            onClick={() => window.open(violation.image_url, '_blank')}
                            title="Click to view full image"
                          />
                          <div className="text-xs text-red-600 mt-1">Click to enlarge</div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default StudentReport;