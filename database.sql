-- ============================================================
-- ADAPTIVE STUDENT LEARNING & PERFORMANCE INTELLIGENCE SYSTEM
-- MySQL 8+ VERSION
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS improvement_log;
DROP TABLE IF EXISTS study_plan;
DROP TABLE IF EXISTS resources;
DROP TABLE IF EXISTS scores;
DROP TABLE IF EXISTS subtopics;
DROP TABLE IF EXISTS topics;
DROP TABLE IF EXISTS subjects;
DROP TABLE IF EXISTS students;
DROP TABLE IF EXISTS teachers;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================
-- CORE TABLES
-- ============================================================

CREATE TABLE students (
    student_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    department VARCHAR(100),
    semester INT CHECK (semester BETWEEN 1 AND 8),
    teacher_email VARCHAR(150) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE teachers (
    teacher_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    department VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subjects (
    subject_id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    code VARCHAR(20) UNIQUE,
    semester INT CHECK (semester BETWEEN 1 AND 8),
    total_marks INT DEFAULT 100,
    weightage DECIMAL(5,2) DEFAULT 1.0
);

CREATE TABLE topics (
    topic_id INT AUTO_INCREMENT PRIMARY KEY,
    subject_id INT,
    topic_name VARCHAR(200) NOT NULL,
    weightage DECIMAL(5,2) DEFAULT 1.0,
    description TEXT,
    FOREIGN KEY (subject_id) REFERENCES subjects(subject_id) ON DELETE CASCADE
);

CREATE TABLE subtopics (
    subtopic_id INT AUTO_INCREMENT PRIMARY KEY,
    topic_id INT,
    subtopic_name VARCHAR(200) NOT NULL,
    description TEXT,
    FOREIGN KEY (topic_id) REFERENCES topics(topic_id) ON DELETE CASCADE
);

CREATE TABLE scores (
    score_id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT,
    topic_id INT,
    marks_obtained DECIMAL(6,2) NOT NULL,
    max_marks DECIMAL(6,2) NOT NULL DEFAULT 100,
    exam_date DATE NOT NULL DEFAULT (CURRENT_DATE),
    exam_type VARCHAR(50) DEFAULT 'unit_test',
    CHECK (marks_obtained >= 0),
    CHECK (max_marks > 0),
    CHECK (marks_obtained <= max_marks),
    FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES topics(topic_id) ON DELETE CASCADE
);

CREATE TABLE resources (
    resource_id INT AUTO_INCREMENT PRIMARY KEY,
    topic_id INT,
    title VARCHAR(255) NOT NULL,
    resource_type VARCHAR(30),
    url TEXT,
    description TEXT,
    difficulty VARCHAR(20) DEFAULT 'beginner',
    FOREIGN KEY (topic_id) REFERENCES topics(topic_id) ON DELETE CASCADE
);

CREATE TABLE study_plan (
    plan_id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT,
    topic_id INT,
    priority_score DECIMAL(8,4),
    score_percentage DECIMAL(5,2),
    suggested_hours DECIMAL(4,1),
    status VARCHAR(20) DEFAULT 'pending',
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (student_id, topic_id),
    FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES topics(topic_id) ON DELETE CASCADE
);

CREATE TABLE improvement_log (
    log_id INT AUTO_INCREMENT PRIMARY KEY,
    student_id INT,
    topic_id INT,
    old_score DECIMAL(5,2),
    new_score DECIMAL(5,2),
    old_pct DECIMAL(5,2),
    new_pct DECIMAL(5,2),
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(student_id) ON DELETE CASCADE,
    FOREIGN KEY (topic_id) REFERENCES topics(topic_id) ON DELETE CASCADE
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_scores_student ON scores(student_id);
CREATE INDEX idx_scores_topic ON scores(topic_id);
CREATE INDEX idx_scores_date ON scores(exam_date);
CREATE INDEX idx_study_plan_student ON study_plan(student_id);
CREATE INDEX idx_topics_subject ON topics(subject_id);

-- ============================================================
-- VIEWS
-- ============================================================

CREATE VIEW student_performance_summary AS
SELECT
    s.student_id,
    st.name AS student_name,
    sub.name AS subject_name,
    t.topic_id,
    t.topic_name,
    t.weightage,
    s.marks_obtained,
    s.max_marks,
    ROUND((s.marks_obtained * 100.0 / s.max_marks), 2) AS score_pct,
    s.exam_date,
    CASE
        WHEN (s.marks_obtained * 100.0 / s.max_marks) < 40 THEN 'critical'
        WHEN (s.marks_obtained * 100.0 / s.max_marks) < 60 THEN 'weak'
        WHEN (s.marks_obtained * 100.0 / s.max_marks) < 75 THEN 'average'
        ELSE 'strong'
    END AS performance_band
FROM (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY student_id, topic_id ORDER BY exam_date DESC) AS rn
    FROM scores
) s
JOIN students st ON s.student_id = st.student_id
JOIN topics t ON s.topic_id = t.topic_id
JOIN subjects sub ON t.subject_id = sub.subject_id
WHERE s.rn = 1;

-- Score trend
CREATE VIEW score_trend AS
SELECT
    s.student_id,
    s.topic_id,
    t.topic_name,
    s.exam_date,
    ROUND((s.marks_obtained * 100.0 / s.max_marks), 2) AS score_pct,
    LAG(ROUND((s.marks_obtained * 100.0 / s.max_marks), 2))
        OVER (PARTITION BY s.student_id, s.topic_id ORDER BY s.exam_date) AS prev_score_pct,
    ROUND((s.marks_obtained * 100.0 / s.max_marks), 2) -
    LAG(ROUND((s.marks_obtained * 100.0 / s.max_marks), 2))
        OVER (PARTITION BY s.student_id, s.topic_id ORDER BY s.exam_date) AS delta
FROM scores s
JOIN topics t ON s.topic_id = t.topic_id;

-- ============================================================
-- STORED PROCEDURE (MySQL version)
-- ============================================================

DELIMITER $$

CREATE PROCEDURE generate_study_roadmap(IN p_student_id INT)
BEGIN
    DELETE FROM study_plan WHERE student_id = p_student_id;

    INSERT INTO study_plan (student_id, topic_id, priority_score, score_percentage, suggested_hours)
    SELECT
        p_student_id,
        t.topic_id,
        (t.weightage * (1 - (s.marks_obtained / s.max_marks))) AS priority_score,
        ROUND((s.marks_obtained * 100.0 / s.max_marks), 2),
        ROUND(
            (t.weightage * (1 - (s.marks_obtained / s.max_marks))) /
            SUM(t.weightage * (1 - (s.marks_obtained / s.max_marks))) OVER () * 40,
        1)
    FROM (
        SELECT *,
               ROW_NUMBER() OVER (PARTITION BY student_id, topic_id ORDER BY exam_date DESC) rn
        FROM scores
        WHERE student_id = p_student_id
    ) s
    JOIN topics t ON s.topic_id = t.topic_id
    WHERE rn = 1 AND (s.marks_obtained * 100.0 / s.max_marks) < 60;

    SELECT * FROM study_plan WHERE student_id = p_student_id ORDER BY priority_score DESC;
END$$

DELIMITER ;

-- ============================================================
-- TRIGGER
-- ============================================================

DELIMITER $$

CREATE TRIGGER trg_score_improvement
AFTER INSERT ON scores
FOR EACH ROW
BEGIN
    DECLARE prev_marks DECIMAL(6,2);
    DECLARE prev_max DECIMAL(6,2);

    SELECT marks_obtained, max_marks
    INTO prev_marks, prev_max
    FROM scores
    WHERE student_id = NEW.student_id
      AND topic_id = NEW.topic_id
      AND score_id <> NEW.score_id
    ORDER BY exam_date DESC
    LIMIT 1;

    IF prev_marks IS NOT NULL THEN
        INSERT INTO improvement_log (
            student_id, topic_id,
            old_score, new_score,
            old_pct, new_pct
        )
        VALUES (
            NEW.student_id,
            NEW.topic_id,
            prev_marks,
            NEW.marks_obtained,
            ROUND(prev_marks * 100.0 / prev_max, 2),
            ROUND(NEW.marks_obtained * 100.0 / NEW.max_marks, 2)
        );
    END IF;
END$$

DELIMITER ;