import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, TrendingUp, Users, AlertTriangle, Award, RefreshCw, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface AnalyticsData {
  totalStudents: number;
  totalExams: number;
  completedExams: number;
  avgScore: number;
  totalViolations: number;
  violationsByType: { type: string; count: number }[];
  scoreDistribution: { range: string; count: number }[];
  topViolators: { name: string; studentId: string; violations: number }[];
}

const COLORS = ['hsl(var(--destructive))', 'hsl(var(--warning))', 'hsl(var(--primary))', 'hsl(var(--success))', 'hsl(var(--secondary))'];

const ExamAnalytics = () => {
  const navigate = useNavigate();
  const [analytics, setAnalytics] = useState<AnalyticsData>({
    totalStudents: 0,
    totalExams: 0,
    completedExams: 0,
    avgScore: 0,
    totalViolations: 0,
    violationsByType: [],
    scoreDistribution: [],
    topViolators: [],
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const isAuthenticated = sessionStorage.getItem('adminAuth');
    if (!isAuthenticated) {
      toast.error("Please login as admin");
      navigate('/admin/login');
      return;
    }

    loadAnalytics();
  }, [navigate]);

  const loadAnalytics = async () => {
    try {
      setLoading(true);

      // Fetch all exams with student info
      const { data: examsData, error: examsError } = await supabase
        .from('exams')
        .select(`
          *,
          students (
            name,
            student_id,
            email
          )
        `);

      if (examsError) throw examsError;

      // Fetch all violations
      const { data: violationsData, error: violationsError } = await supabase
        .from('violations')
        .select('*');

      if (violationsError) throw violationsError;

      // Fetch all answers for MCQ exams
      const { data: answersData, error: answersError } = await supabase
        .from('exam_answers')
        .select('*');

      if (answersError) throw answersError;

      // Fetch all questions
      const { data: questionsData, error: questionsError } = await supabase
        .from('exam_questions')
        .select('*');

      if (questionsError) throw questionsError;

      // Calculate statistics
      const totalStudents = new Set(examsData?.map(e => e.student_id)).size;
      const totalExams = examsData?.length || 0;
      const completedExams = examsData?.filter(e => e.status === 'completed').length || 0;

      // Calculate scores from student attempts (use graded exam data)
      const studentScores: number[] = [];
      const studentAttempts = new Set<string>();

      examsData?.forEach(exam => {
        if (exam.status === 'completed' && exam.students && exam.total_score !== null && exam.max_score !== null && exam.max_score > 0) {
          const studentId = exam.student_id;
          
          // Only count each student once (their best/latest attempt)
          if (!studentAttempts.has(studentId)) {
            studentAttempts.add(studentId);
            const percentage = Math.round((exam.total_score / exam.max_score) * 100);
            studentScores.push(percentage);
          }
        }
      });

      const avgScore = studentScores.length > 0 ? Math.round(studentScores.reduce((a, b) => a + b, 0) / studentScores.length) : 0;

      // Score distribution
      const scoreDistribution = [
        { range: '0-20%', count: studentScores.filter(s => s >= 0 && s < 20).length },
        { range: '20-40%', count: studentScores.filter(s => s >= 20 && s < 40).length },
        { range: '40-60%', count: studentScores.filter(s => s >= 40 && s < 60).length },
        { range: '60-80%', count: studentScores.filter(s => s >= 60 && s < 80).length },
        { range: '80-100%', count: studentScores.filter(s => s >= 80 && s <= 100).length },
      ];

      // Violations by type
      const violationCounts: { [key: string]: number } = {};
      violationsData?.forEach(v => {
        violationCounts[v.violation_type] = (violationCounts[v.violation_type] || 0) + 1;
      });

      const violationsByType = Object.entries(violationCounts)
        .map(([type, count]) => ({ type: type.replace(/_/g, ' '), count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      // Top violators - improved matching by student name and student_id
      const violatorMap = new Map<string, { name: string; studentId: string; violations: number }>();
      
      violationsData?.forEach(v => {
        // Try to find student from exam
        const exam = examsData?.find(e => e.id === v.exam_id);
        const studentName = v.details?.student_name || v.student_name || 'Unknown Student';
        const studentId = v.student_id || v.details?.student_id || 'unknown';
        
        // Create key from student name (normalized) for better grouping
        const normalizedName = studentName.toLowerCase().trim();
        const key = `${normalizedName}_${studentId}`;
        
        if (!violatorMap.has(key)) {
          violatorMap.set(key, {
            name: exam?.students?.name || studentName,
            studentId: exam?.students?.student_id || studentId,
            violations: 0
          });
        }
        
        violatorMap.get(key)!.violations++;
      });

      const topViolators = Array.from(violatorMap.values())
        .sort((a, b) => b.violations - a.violations)
        .slice(0, 5);

      setAnalytics({
        totalStudents,
        totalExams,
        completedExams,
        avgScore,
        totalViolations: violationsData?.length || 0,
        violationsByType,
        scoreDistribution,
        topViolators,
      });

      setLoading(false);
    } catch (error) {
      console.error('Error loading analytics:', error);
      toast.error("Failed to load analytics data");
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="w-16 h-16 animate-spin mx-auto mb-4 text-primary" />
          <p className="text-muted-foreground">Loading analytics...</p>
        </div>
      </div>
    );
  }

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
              <div className="flex items-center gap-2">
                <BarChart3 className="w-8 h-8 text-primary" />
                <div>
                  <h1 className="text-xl font-bold">Exam Analytics Dashboard</h1>
                  <p className="text-sm text-muted-foreground">Comprehensive performance insights</p>
                </div>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={loadAnalytics}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8 max-w-7xl">
        {/* Key Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Students</p>
                  <p className="text-3xl font-bold">{analytics.totalStudents}</p>
                </div>
                <Users className="w-8 h-8 text-primary" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Avg Score</p>
                  <p className="text-3xl font-bold text-success">{analytics.avgScore}%</p>
                </div>
                <Award className="w-8 h-8 text-success" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Violations</p>
                  <p className="text-3xl font-bold text-destructive">{analytics.totalViolations}</p>
                </div>
                <AlertTriangle className="w-8 h-8 text-destructive" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Charts Row */}
        <div className="grid lg:grid-cols-2 gap-6 mb-8">
          {/* Score Distribution */}
          <Card>
            <CardHeader>
              <CardTitle>Score Distribution</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={analytics.scoreDistribution}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="range" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="count" fill="hsl(var(--primary))" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Violations by Type */}
          <Card>
            <CardHeader>
              <CardTitle>Top Violation Types</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={analytics.violationsByType}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ type, percent }) => `${type}: ${(percent * 100).toFixed(0)}%`}
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="count"
                  >
                    {analytics.violationsByType.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        {/* Top Violators Table */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5" />
              Top Violators
            </CardTitle>
          </CardHeader>
          <CardContent>
            {analytics.topViolators.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p>No violations recorded yet</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">Rank</TableHead>
                    <TableHead>Student Name</TableHead>
                    <TableHead>Student ID</TableHead>
                    <TableHead className="text-right">Violations</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {analytics.topViolators.map((violator, index) => (
                    <TableRow key={index}>
                      <TableCell className="font-bold">#{index + 1}</TableCell>
                      <TableCell className="font-medium">{violator.name}</TableCell>
                      <TableCell className="text-muted-foreground">{violator.studentId}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="destructive">{violator.violations}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {violator.violations > 10 ? (
                          <Badge variant="destructive">Critical</Badge>
                        ) : violator.violations > 5 ? (
                          <Badge variant="outline" className="border-destructive text-destructive">High Risk</Badge>
                        ) : (
                          <Badge variant="secondary">Monitor</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default ExamAnalytics;
