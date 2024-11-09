require('dotenv').config();
const express = require("express");
const multer = require("multer");
const mysql = require("mysql2");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const xml2js = require("xml2js");
const FormData = require('form-data');

const app = express();
const port = 3001;

const upload = multer({ dest: "uploads/" });
app.use(express.static(path.join(__dirname, 'public')));

// Conexão com o banco de dados MySQL
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ia_database',
  port: process.env.DB_PORT || 3306
});

// Criação do banco de dados e tabela
db.query("CREATE DATABASE IF NOT EXISTS ia_database;", (err) => {
  if (err) throw err;
  console.log("Banco de dados criado ou já existe.");
});

db.query(`
  CREATE TABLE IF NOT EXISTS db_dados (
    id INT AUTO_INCREMENT PRIMARY KEY,
    data DATETIME DEFAULT CURRENT_TIMESTAMP,
    nomeArquivo VARCHAR(255),
    formatoArquivo VARCHAR(100),
    colunas TEXT
  );
`, (err) => {
  if (err) throw err;
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from src/views
app.use(express.static(path.join(__dirname, 'src/views')));

// Serve index.html on root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/views', 'index.html'));
});

// Função para extrair as colunas do arquivo
function extrairColunas(filePath, fileType) {
  return new Promise((resolve, reject) => {
    if (fileType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const json = xlsx.utils.sheet_to_json(sheet);
      const colunas = Object.keys(json[0]).map(coluna => ({
        nomeColuna: coluna, 
        tipoDado: typeof json[0][coluna] === "string" ? "string" : "int"
      }));
      resolve(colunas);
    } else if (fileType === "text/xml") {
      const parser = new xml2js.Parser();
      fs.readFile(filePath, (err, data) => {
        if (err) reject(err);
        parser.parseString(data, (err, result) => {
          if (err) reject(err);
          const colunas = Object.keys(result).map(coluna => ({
            nomeColuna: coluna, 
            tipoDado: typeof result[coluna] === "string" ? "string" : "int"
          }));
          resolve(colunas);
        });
      });
    } else if (fileType === "text/csv" || fileType === "text/plain") {
      const lines = fs.readFileSync(filePath, "utf-8").split("\n");
      const colunas = lines[0].split(",").map(coluna => ({
        nomeColuna: coluna.trim(), 
        tipoDado: "string"
      }));
      resolve(colunas);
    } else {
      reject("Tipo de arquivo não suportado");
    }
  });
}

// Atualizar a função de envio para a API Gemini
async function enviarParaGemini(contents, filePath) {
  try {
    // Extrair dados da planilha
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const dados = xlsx.utils.sheet_to_json(worksheet);

    // Criar um resumo dos dados
    const resumoDados = dados.slice(0, 5).map(row => {
      return Object.entries(row)
        .map(([col, val]) => `${col}: ${val}`)
        .join(', ');
    });

    // Formatar a mensagem para o Gemini com dados reais
    const prompt = `      
      Analise os seguintes dados de um arquivo ${contents.nomeArquivo}:

      Estrutura das colunas:
      ${contents.colunas.map(col => `- ${col.nomeColuna} (Tipo: ${col.tipoDado})`).join('\n')}
      
      Por favor me de analise: ${contents.nomeArquivo}

      - Formato do arquivo: ${contents.formatoArquivo}
      - Número de colunas: ${contents.colunas.length}
      - Tipos de dados encontrados: ${[...new Set(contents.colunas.map(col => col.tipoDado))].join(', ')}`;

    const response = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
      {
        contents: [{
          parts: [{
            text: prompt
          }]
        }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY
        }
      }
    );

    // Log da resposta completa
    console.log("Análise do Gemini:", response.data.candidates[0].content.parts[0].text);
    
    return response.data;
  } catch (error) {
    console.error("Erro na chamada da API Gemini:", error.response?.data || error.message);
    throw error;
  }
}

app.post("/upload", upload.single("file"), (req, res) => {
  const file = req.file;
  const filePath = path.join(__dirname, "uploads", file.filename);
  const fileType = file.mimetype;
  const fileName = file.originalname;

  console.log(`Arquivo recebido: ${fileName} com tipo ${fileType}`);

  extrairColunas(filePath, fileType).then(async (colunas) => {
    try {
      console.log("Colunas extraídas:", colunas);

      if (!colunas || colunas.length === 0) {
        throw new Error("Nenhuma coluna extraída do arquivo.");
      }

      const contents = {
        nomeArquivo: fileName,
        formatoArquivo: fileType,
        colunas: colunas
      };

      // Enviar para Gemini e esperar resposta
      const geminiResponse = await enviarParaGemini(contents, filePath);

      // Extrair o texto da resposta do Gemini
      const analise = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text || "Sem análise disponível";

      // Salvar no banco de dados
      const colunasString = JSON.stringify(colunas);
      const query = "INSERT INTO db_dados (nomeArquivo, formatoArquivo, colunas) VALUES (?, ?, ?)";
      
      db.query(query, [fileName, fileType, colunasString], (err) => {
        if (err) {
          console.error("Erro ao salvar metadados no banco:", err);
          return res.status(500).json({ message: "Erro ao salvar metadados", error: err.message });
        }
        
        console.log("Metadados salvos com sucesso no banco de dados.");
        res.status(200).json({ 
          message: "Arquivo processado com sucesso!",
          analise: analise,
          metadados: contents
        });
      });
    } catch (err) {
      console.error("Erro ao processar o arquivo:", err.message);
      res.status(500).json({ message: "Erro ao processar o arquivo", error: err.message });
    } finally {
      fs.unlinkSync(filePath);
    }
  }).catch((err) => {
    console.error("Erro ao processar o arquivo:", err.message);
    res.status(500).json({ message: "Erro ao processar o arquivo", error: err.message });
  });
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
