import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Eye, RefreshCw } from "lucide-react";

interface SubjectStudentRow {
  examId: string;
  studentId: string;
  name: string;
  rollNo: string;
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
  totalScore?: number | null;
  maxScore?: number | null;
  percentage?: number | null;
  violations: number;
  photo?: string | null;
}

interface SubjectGroup {
  subjectName: string;
  subjectCode: string;
  students: SubjectStudentRow[];
}

const normalize = (value?: string | null) => (value || "").toLowerCase().trim();

const isSameDate = (a?: string | null, b?: string | null) => {
  if (!a || !b) return true;
  try {
    const dateA = new Date(a).toISOString().split("T")[0];
    const dateB = new Date(b).toISOString().split("T")[0];
    return dateA === dateB;
  } catch {
    return true;
  }
};

const isViolationForExam = (violation: any, exam: any, studentLookup?: Map<string, any>) => {
  if (!violation || !exam) return false;
  const vDetails = violation.details as any;
  const violationSubject = normalize(vDetails?.subject_code || violation.subject_code || null);
  const violationStudentId = violation.student_id || vDetails?.student_id || null;
  const violationRoll = normalize(vDetails?.roll_no);
  const violationStudentName = normalize(vDetails?.student_name || (violation as any)?.student_name);

  const resolvedStudent =
    exam.students ||
    (exam.student_id ? studentLookup?.get(exam.student_id) : undefined) ||
    (exam.students?.student_id ? studentLookup?.get(exam.students.student_id) : undefined);

  const examSubject = normalize(exam.exam_templates?.subject_code || exam.subject_code || null);
  const examStudentId = resolvedStudent?.id || exam.students?.id || exam.student_id || null;
  const examStudentAltId = resolvedStudent?.student_id || exam.students?.student_id || exam.student_id || null;
  const examRoll = normalize(resolvedStudent?.roll_no || exam.students?.roll_no);
  const examStudentName = normalize(resolvedStudent?.name || exam.students?.name);

  if (violation.exam_id && exam.id && violation.exam_id === exam.id) {
    return true;
  }

  const matchesSubject = !examSubject || !violationSubject || examSubject === violationSubject;
  if (!matchesSubject) return false;

  const matchesStudent =
    (violationStudentId && (violationStudentId === examStudentId || violationStudentId === examStudentAltId)) ||
    (violationRoll && examRoll && violationRoll === examRoll) ||
    (violationStudentName && examStudentName && violationStudentName === examStudentName);

  if (!matchesStudent) return false;

  if (exam.started_at && violation.timestamp && !isSameDate(exam.started_at, violation.timestamp)) {
    return false;
  }

  return true;
};

const AdminSubjects = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [subjects, setSubjects] = useState<SubjectGroup[]>([]);
  const [studentLookup, setStudentLookup] = useState<Map<string, any>>(new Map());

  useEffect(() => {
    const isAuthenticated = sessionStorage.getItem("adminAuth");
    if (!isAuthenticated) {
      toast.error("Please login as admin");
      navigate("/admin/login");
      return;
    }

    loadSubjectData();
  }, [navigate]);

  const loadSubjectData = async () => {
    try {
      setLoading(true);
      const [{ data: examsData, error: examsError }, { data: violationsData, error: violationsError }, studentsResponse] =
        await Promise.all([
          supabase
            .from("exams")
            .select(`
              *,
              students (
                id,
                name,
                roll_no,
                face_image_url,
                student_id
              ),
              exam_templates (
                subject_name,
                subject_code
              )
            `)
            .order("started_at", { ascending: false }),
          supabase.from("violations").select("*").order("timestamp", { ascending: false }),
          supabase.from("students").select("id, student_id, roll_no, name, face_image_url"),
        ]);

      if (examsError) throw examsError;
      if (violationsError) throw violationsError;

      const lookup = new Map<string, any>();
      if (!studentsResponse.error && studentsResponse.data) {
        studentsResponse.data.forEach((student: any) => {
          if (student.id) lookup.set(student.id, student);
          if (student.student_id) lookup.set(student.student_id, student);
        });
      }
      setStudentLookup(lookup);

      const grouped = groupExamsBySubject(examsData || [], violationsData || [], lookup);
      setSubjects(grouped);
    } catch (error) {
      console.error("Failed to load subject data:", error);
      toast.error("Failed to load subject overview");
    } finally {
      setLoading(false);
    }
  };

  const groupExamsBySubject = (exams: any[], violations: any[], lookup: Map<string, any>): SubjectGroup[] => {
    const subjectMap = new Map<string, SubjectGroup>();

    exams.forEach((exam) => {
      const subjectName =
        exam.exam_templates?.subject_name || exam.subject_name || "Unnamed Subject";
      const subjectCode =
        exam.exam_templates?.subject_code || exam.subject_code || "N/A";
      const mapKey = `${subjectCode}__${subjectName}`;

      if (!subjectMap.has(mapKey)) {
        subjectMap.set(mapKey, {
          subjectCode,
          subjectName,
          students: [],
        });
      }

      const resolvedStudent =
        exam.students ||
        (exam.student_id ? lookup.get(exam.student_id) : null) ||
        (exam.students?.student_id ? lookup.get(exam.students.student_id) : null);

      const displayName = resolvedStudent?.name || exam.students?.name || "Unknown Student";
      const rollNo =
        resolvedStudent?.roll_no ||
        exam.students?.roll_no ||
        resolvedStudent?.student_id ||
        exam.students?.student_id ||
        "N/A";
      const photo = resolvedStudent?.face_image_url || exam.students?.face_image_url || null;
      const studentIdentifier =
        resolvedStudent?.id ||
        exam.students?.id ||
        resolvedStudent?.student_id ||
        exam.students?.student_id ||
        exam.student_id ||
        "";

      const violationsCount = violations.filter((v) => isViolationForExam(v, exam, lookup)).length;
      const totalScore = typeof exam.total_score === "number" ? exam.total_score : null;
      const maxScore = typeof exam.max_score === "number" ? exam.max_score : null;
      const percentage =
        totalScore !== null && maxScore && maxScore > 0
          ? Math.round((totalScore / maxScore) * 100)
          : null;

      subjectMap.get(mapKey)?.students.push({
        examId: exam.id,
        studentId: studentIdentifier,
        name: displayName,
        rollNo,
        status: exam.status || "unknown",
        startedAt: exam.started_at,
        completedAt: exam.completed_at,
        totalScore,
        maxScore,
        percentage,
        violations: violationsCount,
        photo,
      });
    });

    const sortedSubjects = Array.from(subjectMap.values()).map((subject) => ({
      ...subject,
      students: subject.students.sort((a, b) => {
        const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return bTime - aTime;
      }),
    }));

    return sortedSubjects.sort((a, b) => normalize(a.subjectName).localeCompare(normalize(b.subjectName)));
  };

  const totalStudents = useMemo(
    () => subjects.reduce((sum, subject) => sum + subject.students.length, 0),
    [subjects]
  );

  const handleViewReport = (studentId: string, examId: string) => {
    if (!studentId || !examId) {
      toast.error("Missing exam or student identifier");
      return;
    }
    navigate(`/admin/student-report?studentId=${encodeURIComponent(studentId)}&examId=${encodeURIComponent(examId)}`);
  };

  return (
    <div className="min-h-screen bg-muted/30 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Subject-wise Overview</h1>
            <p className="text-muted-foreground">
              Review every subject with the students who appeared, their scores, violations, and quick access to reports.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate("/admin/dashboard")}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Dashboard
            </Button>
            <Button variant="secondary" onClick={loadSubjectData} disabled={loading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        <Card>
          <CardContent className="flex flex-wrap gap-6 pt-6">
            <div>
              <p className="text-sm text-muted-foreground">Subjects</p>
              <p className="text-2xl font-semibold">{subjects.length}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Students</p>
              <p className="text-2xl font-semibold">{totalStudents}</p>
            </div>
          </CardContent>
        </Card>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">Loading subjects…</span>
          </div>
        ) : subjects.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center text-muted-foreground">
              No subjects available yet. Exams will appear here once students start their tests.
            </CardContent>
          </Card>
        ) : (
          subjects.map((subject) => (
            <Card key={`${subject.subjectCode}-${subject.subjectName}`}>
              <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle className="text-xl">
                    {subject.subjectName}{" "}
                    <span className="text-muted-foreground text-base">({subject.subjectCode})</span>
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">
                    {subject.students.length} {subject.students.length === 1 ? "student" : "students"}
                  </p>
                </div>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Student</TableHead>
                      <TableHead>Roll Number</TableHead>
                      <TableHead>Marks</TableHead>
                      <TableHead>Violations</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {subject.students.map((student) => (
                      <TableRow key={`${student.examId}-${student.studentId}`}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            {student.photo ? (
                              <img
                                src={student.photo}
                                alt={student.name}
                                className="h-12 w-12 rounded-full object-cover border"
                              />
                            ) : (
                              <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center text-xs text-muted-foreground">
                                No Photo
                              </div>
                            )}
                            <div>
                              <p className="font-medium">{student.name}</p>
                              <p className="text-xs text-muted-foreground">
                                Appeared {student.startedAt ? new Date(student.startedAt).toLocaleString() : "N/A"}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>{student.rollNo || "N/A"}</TableCell>
                        <TableCell>
                          {student.totalScore !== null && student.maxScore
                            ? `${student.totalScore}/${student.maxScore}${
                                student.percentage !== null ? ` (${student.percentage}%)` : ""
                              }`
                            : "N/A"}
                        </TableCell>
                        <TableCell>
                          <Badge variant={student.violations > 0 ? "destructive" : "secondary"}>
                            {student.violations} {student.violations === 1 ? "violation" : "violations"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              student.status === "completed"
                                ? "default"
                                : student.status === "in_progress"
                                ? "outline"
                                : "secondary"
                            }
                          >
                            {student.status?.replace(/_/g, " ") || "unknown"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleViewReport(student.studentId, student.examId)}
                          >
                            <Eye className="mr-2 h-4 w-4" />
                            View Report
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
};

export default AdminSubjects;

