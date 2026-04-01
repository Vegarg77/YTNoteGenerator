docker run -d \
    -p 5173:5173 \
    --name=ytnotegenerator \
    -v /path/to/notes:/data/notes \
    -v /path/to/dictionary:/data/dictionary \
    -v /path/to/business:/data/business \
    -v /etc/localtime:/etc/localtime:ro \
    -e OPENAI_API_KEY=your-openai-api-key \
    -e OPENAI_MODEL=gpt-4o-mini \
    -e BRIGHT_DATA_API_TOKEN=your-bright-data-token \
    -e BRIGHT_DATA_YT_DATASET_ID=your-dataset-id \
    -e OBSIDIAN_NOTE_DIR=/data/notes \
    -e OBSIDIAN_DICTIONARY_DIR=/data/dictionary \
    -e OBSIDIAN_BUSINESS_DIR=/data/business \
    ytnotegenerator
