#!/usr/bin/env node

const path = require('path')
const ffmpeg = require('fluent-ffmpeg')
let bento4 = require('fluent-bento4')
const os = require('os')
const fs = require('fs')

if (os.platform() == 'win32') {

    const binarypath = path.resolve('./ffmpeg/bin/')
    const ffmpegPath = path.join(binarypath, 'ffmpeg.exe')
    const ffprobePath = path.join(binarypath, 'ffprobe.exe')

    ffmpeg.setFfmpegPath(ffmpegPath)
    ffmpeg.setFfprobePath(ffprobePath)

    console.log('ffmpeg path', ffmpegPath)
    console.log('ffprobe path', ffprobePath)

} else {

    const ffmpegPath = '/opt/ffmpeg/bin-video/ffmpeg.exe'
    const ffprobePath = '/opt/ffmpeg/bin-video/ffprobe.exe'
    const bento4Path = '/opt/bento4/bin'

    ffmpeg.setFfmpegPath(ffmpegPath)
    ffmpeg.setFfprobePath(ffprobePath)
    bento4 = bento4.setBinPath(bento4Path)

    console.log('ffmpeg path', ffmpegPath)
    console.log('ffprobe path', ffprobePath)
    console.log('bento4 path', bento4Path)
}

async function probeFile(fileName) {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(fileName, function (_err, metaData) {
            resolve(metaData)
        })
    })
}

async function extractStream(fileName, index, target, type) {
    return new Promise((resolve, reject) => {
        const proc = ffmpeg({ source: fileName })
            .on('start', (commandLine) => console.log(commandLine))
            .on('progress', ({ percent }) => console.log(`${fileName} ${percent}% done`))
            .on('end', () => resolve())
            .on('error', (err) => reject(err))

            .output(target)
            .outputOptions([`-map :${index}`])

        if (type === 'video') {
            proc.videoCodec('copy')
        } else {
            proc.audioCodec('copy')
        }

        proc.run()
    })
}

async function encodeVideo(source, index, cwd, specs) {
    for (spec of specs) {
        await encodeFirstPass(source, cwd, spec)
        await encodeSecondPass(cwd, index, spec)
    }
}

async function encodeFirstPass(source, cwd, [height, rate]) {
    return new Promise((resolve, reject) => {

        ffmpeg({ source, cwd })
            .on('start', (command) => console.log(command))
            .on('progress', ({ percent }) => console.log(`${source} ${percent}% done`))
            .on('end', () => resolve())
            .on('error', (err) => reject(err))

        // for (let i = 0; i < specs.length; i++) {
        //     const [height, rate] = specs[i]
        //     proc
                .output(`video_${height}p_${rate}.mp4.pass1`)
                .format('mp4')
                .videoCodec('libx264')
                .size(`?x${height}`)
                .outputOptions([
                    `-x264-params keyint=48:min-keyint=48:scenecut=-1:nal-hrd=cbr`,
                    `-b:v ${rate}k`,
                    `-bufsize ${rate * 2}k`,
                    `-maxrate ${rate}k`,
                    `-profile:v high`,
                    `-level 4.2`,
                    `-pass 1`,
                    `-an`
                ])
        // }

        .run()
    })
}

async function encodeSecondPass(cwd, index, [height, rate]) {
    const firstPassSource = `${cwd}/video_${height}p_${rate}.mp4.pass1`
    return new Promise((resolve, reject) => {
        const proc = ffmpeg({ source: firstPassSource, cwd })
            .on('start', (command) => console.log(command))
            .on('progress', ({ percent }) => console.log(`${firstPassSource} ${percent}% done`))
            .on('end', () => resolve())
            .on('error', (err) => reject(err))

        proc
            .output(`video_${index}_${height}p_${rate}.mp4`)
            .format('mp4')
            .videoCodec('libx264')
            .size(`?x${height}`)
            .outputOptions([
                `-x264-params keyint=48:min-keyint=48:scenecut=-1:nal-hrd=cbr`,
                `-b:v ${rate}k`,
                `-bufsize ${rate * 2}k`,
                `-maxrate ${rate}k`,
                `-profile:v high`,
                `-level 4.2`,
                `-pass 2`,
                `-an`
            ])

        proc.run()
    }).then(() => {
        fs.unlinkSync(firstPassSource)
    })
}

async function createVideoFragments(cwd, index, [height, rate]) {
    const sourceFilename = `${cwd}/video_${index}_${height}p_${rate}.mp4`
    const destinationFilename = `${cwd}/video_${index}_${height}p_${rate}_fragments.mp4`
    return bento4.mp4fragment.exec(destinationFilename, ['--fragment-duration', '2000', sourceFilename])
}

async function createAudioFragments(source, destination) {
    return bento4.mp4fragment.exec(destination, ['--fragment-duration', '2000', source])
}

async function transcodeAudio(source, cwd, destination) {
    return new Promise((resolve, reject) => {
        const proc = ffmpeg({ source, cwd })
            .on('start', (command) => console.log(command))
            .on('progress', ({ percent }) => console.log(`${source} ${percent}% done`))
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .output(destination)
            .format('mp4')
            .audioCodec('aac')
            .audioBitrate('192k')
            .run()
    })
}

async function createManifests(cwd, videoStreams, videoSpecs, audioStreams) {
    const assets = []

    for (stream of videoStreams) {
        for ([height, rate] of videoSpecs) {
            assets.push(`${cwd}/video_${stream.index}_${height}p_${rate}_fragments.mp4`)
        }
    }

    for (stream of audioStreams) {
        assets.push(stream.transcoded_path.replace('.m4a', '_fragments.m4a'))
    }

    return bento4.mp4dash.exec(assets[assets.length - 1], ['--verbose', '--profiles=on-demand', '--mpd-name', 'manifest.mpd', '--hls', '-f', ...assets.slice(0, assets.length - 1)])
}

async function consoleEncode(fileName) {

    const specs = [
        [320, 200],
        [480, 500],
        [720, 1200],
        [1080, 2000]
    ]

    const name = path.basename(fileName, path.extname(fileName))
    const targetDirectory = path.join(__dirname, name)
    const sourceFilename = path.resolve(fileName)

    try {
        fs.statSync(targetDirectory)
    } catch (err) {
        if (err.code === 'ENOENT') {
            fs.mkdirSync(targetDirectory)
        } else {
            throw err
        }
    }

    console.log('source', sourceFilename)
    console.log('info', targetDirectory)

    const metaData = await probeFile(sourceFilename)

    const sourceVideoStreams = metaData.streams
        .filter(({ codec_type }) => codec_type === 'video')
        .map(({ index, codec_type, codec_name, width, height, bit_rate, codec_tag_string }) => {
            const path = `${targetDirectory}/source_${index}_${codec_type}_${codec_name}_${width}x${height}_${bit_rate}_${codec_tag_string}.mp4`
            return { index, codec_type, codec_name, width, height, bit_rate, path }
        })

    const sourceAudioStreams = metaData.streams
        .filter(({ codec_type }) => codec_type === 'audio')
        .map(({ index, codec_type, codec_name, sample_rate, bit_rate, channel_layout, codec_tag_string }) => {
            const path = `${targetDirectory}/source_${index}_${codec_type}_${codec_name}_${sample_rate}_${channel_layout}_${bit_rate}_${codec_tag_string}.m4a`
            const transcoded_path = `${targetDirectory}/audio_aac_192k_${index}.m4a`
            return { index, codec_type, codec_name, sample_rate, bit_rate, channel_layout, codec_tag_string, path, transcoded_path }
        })


    for (stream of [...sourceVideoStreams, ...sourceAudioStreams]) {
        await extractStream(sourceFilename, stream.index, stream.path, stream.codec_type)
    }

    for (stream of sourceVideoStreams) {
        await encodeVideo(stream.path, stream.index, targetDirectory, specs)
        for (spec of specs) {
            await createVideoFragments(targetDirectory, stream.index, spec)
        }
    }

    for (stream of sourceAudioStreams) {
        await transcodeAudio(stream.path, targetDirectory, stream.transcoded_path)
        await createAudioFragments(stream.transcoded_path, stream.transcoded_path.replace('.m4a', '_fragments.m4a'))
    }


    await createManifests(targetDirectory, sourceVideoStreams, specs, sourceAudioStreams)

    // sourceVideoStreams.forEach(async stream => {
    //     await encodeVideo(stream.path, targetDirectory, [
    //         [ 320, 200 ],
    //         [ 480, 500 ],
    //         [ 720, 1200 ],
    //         [ 1080, 2000 ]
    //     ])
    // })


    // console.log('info', sizes)

    /*
    
    try {
        var targetdirInfo = fs.statSync(targetDirectory)
    } catch (err) {
        if (err.code === 'ENOENT') {
            fs.mkdirSync(targetDirectory)
        } else {
            throw err
        }
    }

    var proc = ffmpeg({
        source: sourceFilename,
        cwd: targetDirectory
    })

    const dashManifestFilename = path.join(targetDirectory, `${name}.mpd`)
    const hlsManifestFilename = path.join(targetDirectory, `${name}.m3u8`)


    proc
        .output(dashManifestFilename)
        .format('dash')
        .videoCodec('libx264')
        .audioCodec('aac')
        .audioChannels(2)
        .audioFrequency(44100)
        .outputOptions([
            '-preset veryfast',
            '-keyint_min 60',
            '-g 60',
            '-sc_threshold 0',
            '-profile:v main',
            '-use_template 1',
            '-use_timeline 1',
            '-b_strategy 0',
            '-bf 1',
            '-map 0:a',
            '-b:a 96k'
        ])


    for (var size of sizes) {
        let index = sizes.indexOf(size)

        proc
            .outputOptions([
                `-filter_complex [0]format=pix_fmts=yuv420p[temp${index}];[temp${index}]scale=-2:${size[0]}[A${index}]`,
                `-map [A${index}]:v`,
                `-b:v:${index} ${size[1]}k`,
            ])

            // proc
            //     .output(path.join(targetdir, `${name}_${index}.m3u8`))
            //     .format('hls')
            //     .outputOptions([
            //         '-f hls',
            //         '-movflags frag_keyframe',
            //         '-hls_flags single_file+independent_segments',
            //         '-hls_segment_type fmp4',
            //         '-hls_list_size 0',
            //         '-hls_time 10',
            //         '-hls_allow_cache 1',
            //         `-master_pl_name ${targetdir}/master.m3u8`
            //     ])
    }


    //Fallback version
    proc
        .output(path.join(targetDirectory, `${name}.mp4`))
        .format('mp4')
        .videoCodec('libx264')
        .videoBitrate(fallback[1])
        .size(`?x${fallback[0]}`)
        .audioCodec('aac')
        .audioChannels(2)
        .audioFrequency(44100)
        .audioBitrate(128)
        .outputOptions([
            '-preset veryfast',
            '-movflags +faststart',
            '-keyint_min 60',
            '-refs 5',
            '-g 60',
            '-pix_fmt yuv420p',
            '-sc_threshold 0',
            '-profile:v main',
        ])

        
        proc.on('start', function (commandLine) {
            console.log('progress', 'Spawned Ffmpeg with command: ' + commandLine)
        })
        
        proc.on('progress', function (info) {
            console.log('progress', info)
        })
        .on('end', function () {
            console.log('complete')
        })
        .on('error', function (err) {
            console.log('error', err)
        })
        */
    // return proc.run()
}

consoleEncode(process.argv[2])
