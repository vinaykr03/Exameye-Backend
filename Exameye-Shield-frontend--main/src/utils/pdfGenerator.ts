import jsPDF from 'jspdf';
import { supabase } from '@/integrations/supabase/client';

interface ViolationData {
  id: string;
  violation_type: string;
  severity: string;
  timestamp: string;
  image_url?: string;
  details?: any;
  student_name?: string;
}

export class PDFGenerator {
  async generateStudentReport(
    studentName: string,
    studentId: string,
    violations: ViolationData[],
    subjectName?: string,
    subjectCode?: string,
    examScore?: { total_score: number; max_score: number; percentage: number; grade_letter: string },
    faceImageUrl?: string
  ): Promise<string> {
    const pdf = new jsPDF();
    const pageWidth = pdf.internal.pageSize.getWidth();
    
    // Header - Bold and prominent
    pdf.setFontSize(22);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(220, 38, 38);
    pdf.text('Student Exam Report', pageWidth / 2, 20, { align: 'center' });
    
    // Student Info Section
    pdf.setFont('helvetica', 'normal');
    let yPos = 40;
    
    // Add student face photo if available
    if (faceImageUrl) {
      try {
        // Load and add the face image
        const img = new Image();
        img.crossOrigin = 'anonymous';
        
        // Use a promise to handle async image loading
        await new Promise<void>((resolve, reject) => {
          img.onload = () => {
            try {
              // Add image to PDF (45x45 mm, positioned on the right side)
              const imgWidth = 45;
              const imgHeight = 45;
              const imgX = pageWidth - 65; // Right side with margin
              const imgY = yPos - 3; // Align with text
              
              pdf.addImage(img, 'JPEG', imgX, imgY, imgWidth, imgHeight);
              
              // Add label below image with better font
              pdf.setFontSize(11);
              pdf.setFont('helvetica', 'bold');
              pdf.setTextColor(60, 60, 60);
              const labelText = 'Registration Photo';
              const labelWidth = pdf.getTextWidth(labelText);
              pdf.text(labelText, imgX + (imgWidth - labelWidth) / 2, imgY + imgHeight + 6);
              
              resolve();
            } catch (error) {
              console.error('Error adding face image to PDF:', error);
              reject(error);
            }
          };
          img.onerror = () => {
            console.warn('Failed to load face image for PDF');
            resolve(); // Continue without image
          };
          img.src = faceImageUrl;
        });
      } catch (error) {
        console.error('Error processing face image:', error);
        // Continue without image
      }
    }
    
    // Student Information with better font styling
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    pdf.setTextColor(60, 60, 60);
    
    // Student ID
    pdf.setFont('helvetica', 'bold');
    pdf.text('Student ID:', 20, yPos);
    pdf.setFont('helvetica', 'normal');
    pdf.text(`${studentId || 'N/A'}`, 20 + pdf.getTextWidth('Student ID: ') + 2, yPos);
    yPos += 7;
    
    // Student Name
    pdf.setFont('helvetica', 'bold');
    pdf.text('Student Name:', 20, yPos);
    pdf.setFont('helvetica', 'normal');
    pdf.text(`${studentName || 'Unknown Student'}`, 20 + pdf.getTextWidth('Student Name: ') + 2, yPos);
    yPos += 7;
    
    // Subject
    if (subjectName && subjectCode) {
      pdf.setFont('helvetica', 'bold');
      pdf.text('Subject:', 20, yPos);
      pdf.setFont('helvetica', 'normal');
      pdf.text(`${subjectName} (${subjectCode})`, 20 + pdf.getTextWidth('Subject: ') + 2, yPos);
      yPos += 7;
    }
    
    // Exam Score Section (if available)
    if (examScore) {
      yPos += 3;
      pdf.setFontSize(13);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(34, 139, 34); // Green color for score
      pdf.text('Exam Results:', 20, yPos);
      yPos += 8;
      
      pdf.setFontSize(11);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(0, 0, 0);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Score:', 20, yPos);
      pdf.setFont('helvetica', 'normal');
      pdf.text(` ${examScore.total_score}/${examScore.max_score} (${examScore.percentage}%)`, 20 + pdf.getTextWidth('Score:'), yPos);
      yPos += 7;
      pdf.setFont('helvetica', 'bold');
      pdf.text('Grade:', 20, yPos);
      pdf.setFont('helvetica', 'normal');
      pdf.text(` ${examScore.grade_letter}`, 20 + pdf.getTextWidth('Grade:'), yPos);
      yPos += 10;
    }
    
    // Generated timestamp
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 100, 100);
    pdf.text(`Generated: ${new Date().toLocaleString()}`, 20, yPos);
    yPos += 5;
    
    // Separator
    const separatorY = yPos;
    pdf.setLineWidth(0.5);
    pdf.setDrawColor(220, 38, 38);
    pdf.line(20, separatorY, pageWidth - 20, separatorY);
    
    // Summary Section
    pdf.setFontSize(16);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(0, 0, 0);
    pdf.text('Summary', 20, separatorY + 13);
    
    pdf.setFontSize(11);
    pdf.setFont('helvetica', 'normal');
    pdf.text(`Total Violations: ${violations.length}`, 20, separatorY + 23);
    pdf.setFontSize(10);
    pdf.setTextColor(100, 100, 100);
    pdf.text(`Report Generated: ${new Date().toLocaleString()}`, 20, separatorY + 31);
    
    // Violation Breakdown
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(0, 0, 0);
    pdf.text('Violation Breakdown', 20, separatorY + 48);
    
    // Count violations by type
    const violationCounts: { [key: string]: number } = {};
    violations.forEach(v => {
      const type = v.violation_type;
      violationCounts[type] = (violationCounts[type] || 0) + 1;
    });
    
    // Table Header
    const tableHeaderY = separatorY + 56;
    pdf.setFontSize(11);
    pdf.setFont('helvetica', 'bold');
    pdf.setFillColor(220, 38, 38);
    pdf.rect(20, tableHeaderY, pageWidth - 40, 8, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.text('Violation Type', 25, tableHeaderY + 5.5);
    pdf.text('Count', pageWidth / 2, tableHeaderY + 5.5);
    pdf.text('Percentage', pageWidth - 60, tableHeaderY + 5.5);
    
    // Table Rows
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.setTextColor(0, 0, 0);
    let tableYPos = tableHeaderY + 15;
    Object.entries(violationCounts).forEach(([type, count], index) => {
      const percentage = ((count / violations.length) * 100).toFixed(1);
      
      if (index % 2 === 0) {
        pdf.setFillColor(245, 245, 245);
        pdf.rect(20, tableYPos - 5, pageWidth - 40, 8, 'F');
      }
      
      // Format violation type for display
      const formatType = (t: string) => {
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
        return typeMap[t] || t.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      };
      
      pdf.text(formatType(type), 25, tableYPos);
      pdf.text(count.toString(), pageWidth / 2, tableYPos);
      pdf.text(`${percentage}%`, pageWidth - 60, tableYPos);
      
      tableYPos += 10;
    });
    
    // Detailed Violations with Evidence Images
    yPos = tableYPos;
    if (yPos > 200) {
      pdf.addPage();
      yPos = 20;
    } else {
      yPos += 10;
    }
    
    pdf.setFontSize(14);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(0, 0, 0);
    pdf.text('Detailed Violations with Evidence', 20, yPos);
    yPos += 10;
    
    // Include up to 10 violations with images
    const violationsToShow = violations.slice(0, 10);
    
    for (let index = 0; index < violationsToShow.length; index++) {
      const violation = violationsToShow[index];
      
      // Check if we need a new page (accounting for image space)
      if (yPos > 220) {
        pdf.addPage();
        yPos = 20;
      }
      
      // Format violation type name
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
      
      // Violation details with better font styling
      pdf.setFontSize(11);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(0, 0, 0);
      pdf.text(`${index + 1}. Violation: ${formatViolationType(violation.violation_type).toUpperCase()}`, 25, yPos);
      
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(80, 80, 80);
      pdf.text(`Time: ${new Date(violation.timestamp).toLocaleString()}`, 25, yPos + 6);
      pdf.text(`Severity: ${violation.severity.toUpperCase()}`, 25, yPos + 11);
      
      if (violation.details?.message) {
        pdf.setFontSize(9);
        pdf.setTextColor(100, 100, 100);
        pdf.text(`Details: ${violation.details.message}`, 25, yPos + 16);
      }
      
      // Add evidence image if available
      if (violation.image_url) {
        try {
          // Add a small thumbnail with tag
          pdf.setFontSize(9);
          pdf.setFont('helvetica', 'bold');
          pdf.setTextColor(220, 38, 38);
          pdf.text('Evidence Photo Captured', 25, yPos + 22);
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(8);
          pdf.setTextColor(100, 100, 100);
          pdf.text(`Type: ${violation.violation_type.replace(/_/g, ' ')}`, 25, yPos + 27);
          
          // Note: jsPDF requires image to be loaded first for embedding
          // For now, we'll just reference the URL
          pdf.setFontSize(8);
          pdf.setTextColor(0, 0, 255);
          pdf.textWithLink('View Evidence Image', 25, yPos + 32, { url: violation.image_url });
          
          yPos += 40;
        } catch (error) {
          console.error('Error adding image to PDF:', error);
          yPos += 25;
        }
      } else {
        yPos += 25;
      }
    }
    
    // Footer note about evidence
    pdf.addPage();
    pdf.setFontSize(12);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(0, 0, 0);
    pdf.text('Evidence Images:', 20, 20);
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 100, 100);
    pdf.text('All violation evidence images are stored securely in the system.', 20, 28);
    pdf.text('Click on the blue "View Evidence Image" links above to access snapshots.', 20, 34);
    
    let evidenceYPos = 44;
    violations.filter(v => v.image_url).forEach((violation, idx) => {
      if (evidenceYPos > 270) {
        pdf.addPage();
        evidenceYPos = 20;
      }
      // Format violation type
      const formatType = (t: string) => {
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
        return typeMap[t] || t.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      };
      
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(0, 0, 0);
      pdf.text(`${idx + 1}. ${formatType(violation.violation_type)}`, 25, evidenceYPos);
      pdf.setFontSize(9);
      pdf.setTextColor(0, 0, 255);
      pdf.textWithLink('Open Image', 80, evidenceYPos, { url: violation.image_url });
      evidenceYPos += 7;
    });
    
    // Generate PDF blob
    const pdfBlob = pdf.output('blob');
    
    // Upload to Supabase Storage
    const sanitizedName = (studentName || 'Unknown_Student').replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
    const fileName = `${sanitizedName}/reports/violation_report_${Date.now()}.pdf`;
    
    const { data, error } = await supabase.storage
      .from('exam-reports')
      .upload(fileName, pdfBlob, {
        cacheControl: '3600',
        upsert: false
      });

    if (error) throw error;

    const { data: { publicUrl } } = supabase.storage
      .from('exam-reports')
      .getPublicUrl(fileName);

    return publicUrl;
  }

  async exportToCSV(violations: ViolationData[]): Promise<string> {
    const headers = ['Timestamp', 'Student Name', 'Violation Type', 'Severity', 'Details', 'Confidence', 'Evidence Image URL', 'Has Evidence'];
    const rows = violations.map(v => [
      new Date(v.timestamp).toLocaleString(),
      v.details?.student_name || v.student_name || 'Unknown Student',
      v.violation_type.replace(/_/g, ' '),
      v.severity,
      v.details?.message || '',
      v.details?.confidence ? `${(v.details.confidence * 100).toFixed(1)}%` : 'N/A',
      v.image_url || 'No evidence captured',
      v.image_url ? 'Yes' : 'No'
    ]);
    
    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');
    
    return csvContent;
  }
}

export const pdfGenerator = new PDFGenerator();
