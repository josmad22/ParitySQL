// Resaltador de sintaxis T-SQL ligero. Un solo paso con alternación ordenada:
// comentarios y cadenas se consumen primero para que no se recoloreen por dentro.
(function () {
  const KEYWORDS = [
    "ADD","ALL","ALTER","AND","AS","ASC","BEGIN","BETWEEN","BY","CASE","CATCH","COLUMN",
    "CONSTRAINT","CREATE","CROSS","DECLARE","DEFAULT","DELETE","DESC","DISTINCT","DROP",
    "ELSE","END","EXEC","EXECUTE","EXISTS","FETCH","FOR","FOREIGN","FROM","FUNCTION",
    "GROUP","HAVING","IDENTITY","IF","IN","INDEX","INNER","INSERT","INTO","IS","JOIN",
    "KEY","LEFT","LIKE","NOT","NULL","OFF","ON","OR","ORDER","OUTER","OUTPUT","PRIMARY",
    "PROC","PROCEDURE","REFERENCES","RETURN","RETURNS","RIGHT","SELECT","SET","TABLE",
    "THEN","TOP","TRIGGER","TRY","UNION","UPDATE","USE","VALUES","VIEW","WHEN","WHERE","WITH"
  ];
  const TYPES = [
    "BIGINT","BINARY","BIT","CHAR","DATE","DATETIME","DATETIME2","DATETIMEOFFSET","DECIMAL",
    "FLOAT","IMAGE","INT","MONEY","NCHAR","NTEXT","NUMERIC","NVARCHAR","REAL","SMALLDATETIME",
    "SMALLINT","SMALLMONEY","SYSNAME","TEXT","TIME","TINYINT","UNIQUEIDENTIFIER","VARBINARY",
    "VARCHAR","XML",
    "OBJECT_ID","OBJECT_DEFINITION","DATEDIFF","DATEADD","GETDATE","SYSDATETIME","GETUTCDATE",
    "YEAR","MONTH","DAY","ISNULL","COALESCE","COUNT","SUM","MAX","MIN","AVG","CAST","CONVERT",
    "LEN","SUBSTRING","REPLACE","NEWID","ROW_NUMBER","RTRIM","LTRIM","UPPER","LOWER"
  ];

  const kw = KEYWORDS.join("|");
  const ty = TYPES.join("|");

  // Orden importa: comentarios -> cadenas -> params -> GO -> keywords -> tipos/func -> números
  const RE = new RegExp(
    "(\\/\\*[\\s\\S]*?\\*\\/)" +          // 1 block comment
      "|(--[^\\n]*)" +                    // 2 line comment
      "|('(?:[^']|'')*')" +               // 3 string
      "|(@[A-Za-z_][A-Za-z0-9_]*)" +      // 4 parameter
      "|\\b(GO)\\b" +                      // 5 go
      "|\\b(" + kw + ")\\b" +             // 6 keyword
      "|\\b(" + ty + ")\\b" +            // 7 type/function
      "|\\b(\\d+(?:\\.\\d+)?)\\b",        // 8 number
    "gi"
  );

  function esc(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  window.highlightSql = function (code) {
    const escaped = esc(code);
    return escaped.replace(RE, function (m, com1, com2, str, par, go, k, t, num) {
      if (com1 || com2) return '<span class="tok-com">' + m + "</span>";
      if (str) return '<span class="tok-str">' + str + "</span>";
      if (par) return '<span class="tok-par">' + par + "</span>";
      if (go) return '<span class="tok-go">' + go + "</span>";
      if (k) return '<span class="tok-kw">' + k + "</span>";
      if (t) return '<span class="tok-typ">' + t + "</span>";
      if (num) return '<span class="tok-num">' + num + "</span>";
      return m;
    });
  };
})();
